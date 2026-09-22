import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getTypesafeApiKey } from "../route-planner/route-jev.js";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";

// Thresholds mirrored from thruwire/foreman policy.py.
const THRESHOLDS = {
  human: 0.8,
  stuck: 0.8,
  offTrack: 0.8,
  agentsDrift: 0.8,
  verification: 0.65,
  implementationForVerify: 0.75,
  finish: 0.85,
  requirements: 0.8,
  tests: 0.75,
} as const;

const NOUL_QUESTIONS: Record<string, string> = {
  implementation_complete: "Is the implementation work required by the original job complete?",
  tests_sufficient: "Does the work have sufficient relevant test coverage and passing verification?",
  requirements_satisfied: "Does the current state satisfy the original free-form job as a whole?",
  needs_verification: "Does the current state warrant an independent verification pass before finishing?",
  meaningful_progress: "Is the active or most recent worker making meaningful progress toward the job?",
  worker_stuck: "Does the active or most recent worker appear stuck, looping, or unable to advance?",
  work_off_track: "Is the current work drifting from the original job or making unrelated changes?",
  agents_md_drift:
    "When AGENTS.md instructions are present, is the worker's behavior or repository work materially inconsistent with those instructions? Answer no when no AGENTS.md is present or evidence is insufficient.",
  ready_to_finish: "Given all evidence, is the factory job ready to be declared complete?",
  needs_human: "Does this situation require human judgment, credentials, clarification, or permission?",
};

export interface ForemanScores {
  implementation_complete: number;
  tests_sufficient: number;
  requirements_satisfied: number;
  needs_verification: number;
  meaningful_progress: number;
  worker_stuck: number;
  work_off_track: number;
  agents_md_drift: number;
  ready_to_finish: number;
  needs_human: number;
}

export type ForemanAction =
  | "CONTINUE"
  | "STEER"
  | "STOP_AND_RETRY"
  | "VERIFY"
  | "FINISH"
  | "ESCALATE";

export interface ForemanDecision {
  action: ForemanAction;
  reason: string;
  scores: ForemanScores;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function decide(scores: ForemanScores, opts?: { activeWorker?: boolean }): ForemanDecision {
  const activeWorker = opts?.activeWorker ?? true;

  if (scores.needs_human >= THRESHOLDS.human) {
    return { action: "ESCALATE", reason: "Jev says human input needed (credentials, judgment, or permission).", scores };
  }

  if (activeWorker) {
    if (scores.worker_stuck >= THRESHOLDS.stuck) {
      return { action: "STEER", reason: "Worker appears stuck or looping. Change approach or narrow the task.", scores };
    }
    if (scores.work_off_track >= THRESHOLDS.offTrack) {
      return { action: "STEER", reason: "Work is drifting from the original job. Re-anchor to the stated goal.", scores };
    }
    if (scores.agents_md_drift >= THRESHOLDS.agentsDrift) {
      return { action: "STEER", reason: "Worker behavior drifts from AGENTS.md instructions. Restate the rules.", scores };
    }
    return { action: "CONTINUE", reason: "Worker is making progress; no intervention needed.", scores };
  }

  const finishReady =
    scores.ready_to_finish >= THRESHOLDS.finish &&
    scores.requirements_satisfied >= THRESHOLDS.requirements &&
    scores.tests_sufficient >= THRESHOLDS.tests;
  const verificationResolved =
    scores.needs_verification < THRESHOLDS.verification;

  if (finishReady && verificationResolved) {
    return { action: "FINISH", reason: "Completion thresholds met and no verification outstanding.", scores };
  }

  const shouldVerify =
    scores.needs_verification >= THRESHOLDS.verification &&
    scores.implementation_complete >= THRESHOLDS.implementationForVerify;
  if (shouldVerify) {
    return { action: "VERIFY", reason: "Independent verification pass is warranted before finishing.", scores };
  }

  return { action: "CONTINUE", reason: "Work remains; keep going.", scores };
}

export async function runForemanAssess(
  input: {
    job: string;
    workSummary: string;
    gitStatus?: string;
    testsResult?: string;
    activeWorker?: boolean;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<ForemanDecision> {
  const apiKey = await getTypesafeApiKey();
  const state = {
    job: input.job,
    work_summary: input.workSummary,
    git_status: input.gitStatus ?? "",
    tests_result: input.testsResult ?? "",
    active_worker: input.activeWorker ?? true,
  };

  const questions: Record<string, { type: string; instructions: string }> = {};
  for (const [name, instructions] of Object.entries(NOUL_QUESTIONS)) {
    questions[name] = { type: "noul", instructions };
  }

  if (!apiKey) {
    return {
      action: "CONTINUE",
      reason: "TYPESAFE_API_KEY not found; foreman gate disabled.",
      scores: emptyScores(),
    };
  }

  let response: Response;
  try {
    response = await fetchImpl(JEV_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return {
      action: "CONTINUE",
      reason: `Jev request failed, fail-open: ${err instanceof Error ? err.message : String(err)}`,
      scores: emptyScores(),
    };
  }

  if (!response.ok) {
    return {
      action: "CONTINUE",
      reason: `Jev returned ${response.status}, fail-open.`,
      scores: emptyScores(),
    };
  }

  const data = (await response.json()) as {
    answers?: Record<string, { noul?: number }>;
  };

  const raw = data.answers ?? {};
  const scores: ForemanScores = {
    implementation_complete: clamp01(raw.implementation_complete?.noul ?? 0),
    tests_sufficient: clamp01(raw.tests_sufficient?.noul ?? 0),
    requirements_satisfied: clamp01(raw.requirements_satisfied?.noul ?? 0),
    needs_verification: clamp01(raw.needs_verification?.noul ?? 0),
    meaningful_progress: clamp01(raw.meaningful_progress?.noul ?? 0),
    worker_stuck: clamp01(raw.worker_stuck?.noul ?? 0),
    work_off_track: clamp01(raw.work_off_track?.noul ?? 0),
    agents_md_drift: clamp01(raw.agents_md_drift?.noul ?? 0),
    ready_to_finish: clamp01(raw.ready_to_finish?.noul ?? 0),
    needs_human: clamp01(raw.needs_human?.noul ?? 0),
  };

  return decide(scores, { activeWorker: input.activeWorker });
}

function emptyScores(): ForemanScores {
  return {
    implementation_complete: 0,
    tests_sufficient: 0,
    requirements_satisfied: 0,
    needs_verification: 0,
    meaningful_progress: 0,
    worker_stuck: 0,
    work_off_track: 0,
    agents_md_drift: 0,
    ready_to_finish: 0,
    needs_human: 0,
  };
}

export default function foremanExtension(pi: ExtensionAPI) {
  const z = pi.zod;

  pi.registerTool({
    name: "foreman_assess",
    label: "Foreman Independent Assessment (heavy)",
    description:
      "Heavyweight 10-dimension independent assessment (completion, tests, requirements, stuck, off-track, agents.md drift, needs-human, etc.) with a recommended action (CONTINUE/STEER/VERIFY/FINISH/ESCALATE). Use for long multi-step tasks, parallel/dag routes, or when the route plan says recommendedGate=heavy. Do NOT use for short single-file tasks—use jev_acceptance_gate instead.",
    parameters: z.object({
      job: z.string().describe("The original task or ticket you were asked to do"),
      workSummary: z.string().describe("What you actually did so far: files changed, commands run, errors hit. Evidence, not claims."),
      gitStatus: z.string().optional().describe("git status / diff stat output, if available"),
      testsResult: z.string().optional().describe("Test run output or summary, if available"),
      activeWorker: z.boolean().optional().describe("Set false if you are wrapping up and want finish/verification decisions; true if work is still ongoing"),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const decision = await runForemanAssess({
        job: params.job,
        workSummary: params.workSummary,
        gitStatus: params.gitStatus,
        testsResult: params.testsResult,
        activeWorker: params.activeWorker,
      });

      const scoreLines = Object.entries(decision.scores)
        .map(([k, v]) => `  ${k}: ${v.toFixed(2)}`)
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: [
              `Foreman decision: ${decision.action}`,
              `Reason: ${decision.reason}`,
              "",
              "Scores:",
              scoreLines,
              "",
              actionHint(decision.action),
            ].join("\n"),
          },
        ],
        details: decision,
      };
    },
  });
}

function actionHint(action: ForemanAction): string {
  switch (action) {
    case "FINISH":
      return "You can summarize and report completion to the user.";
    case "VERIFY":
      return "Spend one independent verification pass (run tests, re-read the diff, check edge cases) before finishing.";
    case "STEER":
      return "Do not keep repeating what you are doing. Change approach, narrow scope, or ask the user for clarification.";
    case "STOP_AND_RETRY":
      return "Stop current attempt and start fresh with a narrower plan.";
    case "ESCALATE":
      return "Stop and tell the user what human input is needed.";
    default:
      return "Continue working.";
  }
}
