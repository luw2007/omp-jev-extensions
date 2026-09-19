import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getTypesafeApiKey } from "../route-planner/route-jev.js";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
const STOP_AUDIT_PATH = join(homedir(), ".omp", "agent", "stop-audit.jsonl");

interface StopAuditRecord {
  timestamp: string;
  target: string;
  acceptance: string;
  summary?: string;
  accepted: boolean;
  confidence?: number;
  reason?: string;
  status: "passed" | "rejected" | "jev_error" | "jev_unavailable";
}

async function logStopAudit(record: Omit<StopAuditRecord, "timestamp">): Promise<void> {
  const entry: StopAuditRecord = { timestamp: new Date().toISOString(), ...record };
  try {
    await appendFile(STOP_AUDIT_PATH, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // non-blocking
  }
}

interface JevBooleanAnswer {
  answer?: boolean;
  choice?: string;
  confidence?: number;
  reasoning?: string;
}

interface StopGateInput {
  target: string;
  acceptance: string;
  summary: string;
}

function parseBooleanAnswer(ans: JevBooleanAnswer | undefined): boolean | undefined {
  if (!ans) return undefined;
  if (typeof ans.answer === "boolean") return ans.answer;
  if (typeof ans.choice === "string") {
    const c = ans.choice.trim().toLowerCase();
    if (c === "accepted" || c === "true" || c === "yes") return true;
    if (c === "rejected" || c === "false" || c === "no") return false;
  }
  return undefined;
}

export async function runAcceptanceGate(
  input: StopGateInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accepted: boolean; confidence: number; reason: string }> {
  const apiKey = await getTypesafeApiKey();
  if (!apiKey) {
    await logStopAudit({ ...input, accepted: true, status: "jev_unavailable" });
    return { accepted: true, confidence: 0, reason: "TYPESAFE_API_KEY not found; gate disabled, allowing stop." };
  }

  const state = {
    target: input.target,
    acceptance_criteria: input.acceptance,
    completed_work_summary: input.summary,
  };

  const questions = {
    done: {
      type: "choice" as const,
      instructions:
        "Decide whether the completed work satisfies the acceptance criteria. Read the summary as evidence, not as a claim. If tests are absent, errors are unaddressed, or the summary asserts completion without showing observable evidence, reject.",
      criteria: {
        accepted:
          "Every acceptance criterion has observable evidence in the summary: files changed, tests run, outputs verified. No unresolved errors or open questions.",
        rejected:
          "At least one criterion lacks evidence, or the summary overstates completion.",
      },
    },
  };

  let response: Response;
  try {
    response = await fetchImpl(JEV_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    const reason = `Jev request failed: ${err instanceof Error ? err.message : String(err)}`;
    await logStopAudit({ ...input, accepted: true, reason, status: "jev_error" });
    // fail-open: don't trap the agent if Jev is down
    return { accepted: true, confidence: 0, reason: `Jev unavailable, allowing stop: ${reason}` };
  }

  if (!response.ok) {
    const reason = `Jev returned ${response.status}`;
    await logStopAudit({ ...input, accepted: true, reason, status: "jev_error" });
    return { accepted: true, confidence: 0, reason: `Jev error, allowing stop: ${reason}` };
  }

  const data = (await response.json()) as {
    answers?: { done?: JevBooleanAnswer };
  };

  const accepted = parseBooleanAnswer(data.answers?.done);
  if (accepted === undefined) {
    await logStopAudit({ ...input, accepted: true, reason: "missing answer", status: "jev_error" });
    return { accepted: true, confidence: 0, reason: "Jev response malformed, allowing stop." };
  }

  const ans = data.answers!.done!;
  const confidence = typeof ans.confidence === "number" ? ans.confidence : 0.5;

  if (accepted) {
    await logStopAudit({ ...input, accepted: true, confidence, status: "passed" });
    return {
      accepted: true,
      confidence,
      reason: `Jev accepted completion (confidence ${confidence.toFixed(2)}).`,
    };
  }

  const reason = ans.reasoning
    ? `Jev rejected completion: ${ans.reasoning}`
    : "Jev rejected completion: acceptance criteria not met per evidence.";
  await logStopAudit({ ...input, accepted: false, confidence, reason, status: "rejected" });
  return { accepted: false, confidence, reason };
}

export default function stopJevExtension(pi: ExtensionAPI) {
  const z = pi.zod;

  pi.registerTool({
    name: "jev_acceptance_gate",
    label: "Jev Acceptance Gate",
    description:
      "Before reporting a task done, call this tool. It sends the acceptance criteria and your work summary to Jev. If Jev says not done, continue working; do not summarize to the user until it returns accepted=true.",
    parameters: z.object({
      target: z.string().describe("The original task target or goal"),
      acceptance: z.string().describe("The concrete acceptance criteria you were asked to meet"),
      summary: z.string().describe("What you actually did: files changed, tests run, outputs observed. Stick to evidence, not claims."),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = await runAcceptanceGate({
        target: params.target,
        acceptance: params.acceptance,
        summary: params.summary,
      });

      if (result.accepted) {
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              `Acceptance NOT met. ${result.reason}\n\n` +
              "Continue working to close the gap. Do not tell the user the task is done until jev_acceptance_gate returns accepted=true.",
          },
        ],
        details: result,
      };
    },
  });
}
