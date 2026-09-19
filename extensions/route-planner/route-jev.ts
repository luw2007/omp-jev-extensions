import {
  type KnownAgent,
  KNOWN_AGENTS,
  MODEL_ROLES,
  type ModelRole,
  type RoutePlan,
  type RouteSlice,
  validateRoutePlanInvariants,
} from "./route-schema.js";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";

// Read the Typesafe API key from the environment.
// Exported so the acceptance-gate extension can reuse it.
export async function getTypesafeApiKey(): Promise<string | undefined> {
  return process.env.TYPESAFE_API_KEY;
}

export interface CandidateSliceInput {
  id: string;
  target: string;
  change: string;
  acceptance: string;
  isReadonly?: boolean;
}

export interface RoutePromptContext {
  task: string;
  candidates: CandidateSliceInput[];
  pinnedAgent?: KnownAgent;
}

export function buildRouteState(ctx: RoutePromptContext): Record<string, unknown> {
  return {
    task: ctx.task,
    candidates: ctx.candidates,
    catalog: KNOWN_AGENTS,
    pinnedAgent: ctx.pinnedAgent ?? null,
    constraints: [
      "No circular dependencies",
      "Readonly research must go to scout",
      "Max 32 concurrent subagents",
      "Implementation agents must not be read-only",
      "Exact target/change/acceptance must be specified",
    ],
  };
}

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export function buildRouteQuestions(
  candidates: CandidateSliceInput[],
  pinnedAgent?: KnownAgent,
): Record<string, JevChoiceQuestion> {
  const questions: Record<string, JevChoiceQuestion> = {};

  questions.mode = {
    type: "choice",
    instructions: "Choose the execution topology: direct (no subagent needed), single (1 task), parallel (independent tasks), or dag (tasks with dependencies).",
    criteria: {
      direct: "User request is purely conversational or can be resolved immediately without subagent",
      single: "A single focused subagent task is sufficient",
      parallel: "Independent subagent tasks that can execute concurrently with no mutual dependencies",
      dag: "Multiple subagent tasks with explicit dependencies or sequential contract requirements",
    },
  };

  for (const c of candidates) {
    questions[`agent_${c.id}`] = {
      type: "choice",
      instructions: `Choose the target agent class for slice ${c.id}. Pinned agent constraint: ${pinnedAgent ?? "none"}.`,
      criteria: {
        scout: "Read-only research and exploratory codebase analysis",
        fast: "Routine implementation or mechanical refactoring",
        smart: "Complex reasoning, cross-module architecture, or root-cause diagnosis",
        "task-opus": "Adversarial architecture arbitration or strict review",
      },
    };

    questions[`model_${c.id}`] = {
      type: "choice",
      instructions: `Choose the model tier for slice ${c.id}. Cheaper tiers when the task is mechanical; heavier tiers when reasoning spans modules or risk is high.`,
      criteria: {
        fast: "Mechanical edits, grep/replace, test writing, single-file changes",
        smart: "Cross-module reasoning, subtle bugs, non-trivial refactoring",
        slow: "Long-context review, architecture critique, deep multi-file analysis",
        task: "Highest-budget implementation when the slice is the critical path",
      },
    };
  }

  return questions;
}

export async function askJevRoutePlan(
  ctx: RoutePromptContext,
  fetchImpl: typeof fetch = fetch,
): Promise<RoutePlan> {
  const apiKey = await getTypesafeApiKey();
  if (!apiKey) {
    throw new Error("Missing TYPESAFE_API_KEY for Jev route decision");
  }

  const state = buildRouteState(ctx);
  const questions = buildRouteQuestions(ctx.candidates, ctx.pinnedAgent);

  const requestBody = {
    model: JEV_MODEL,
    state,
    questions,
  };

  const response = await fetchImpl(JEV_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Jev request failed (${response.status}): ${await response.text()}`);
  }

  const data = (await response.json()) as {
    answers?: Record<string, { choice?: string; confidence?: number; probabilities?: Record<string, number> }>;
  };

  if (!data?.answers || !data.answers.mode?.choice) {
    throw new Error("Jev response missing required mode decision");
  }

  const mode = data.answers.mode.choice as RoutePlan["mode"];
  const slices: RouteSlice[] = [];

  if (mode !== "direct") {
    for (const c of ctx.candidates) {
      const chosenAgent = (data.answers[`agent_${c.id}`]?.choice ?? (c.isReadonly ? "scout" : "fast")) as KnownAgent;
      const fallbackModel: ModelRole =
        chosenAgent === "scout" ? "fast" : chosenAgent === "smart" ? "smart" : "fast";
      const rawModel = data.answers[`model_${c.id}`]?.choice;
      const chosenModel: ModelRole = (MODEL_ROLES as readonly string[]).includes(rawModel ?? "")
        ? (rawModel as ModelRole)
        : fallbackModel;
      slices.push({
        id: c.id,
        agent: ctx.pinnedAgent ?? chosenAgent,
        taskClass: chosenAgent === "scout" ? "research" : chosenAgent === "smart" ? "smart" : "routine",
        dependsOn: [],
        target: c.target,
        change: c.change,
        acceptance: c.acceptance,
        model: chosenModel,
      });
    }

    if (mode === "dag" && slices.length > 1) {
      // Connect sequential chain if DAG chosen
      for (let i = 1; i < slices.length; i++) {
        slices[i].dependsOn = [slices[i - 1].id];
      }
    }
  }

  const plan: RoutePlan = {
    version: 1,
    mode,
    rationale: `Jev selected topology: ${mode}`,
    slices,
  };

  validateRoutePlanInvariants(plan);
  return plan;
}
