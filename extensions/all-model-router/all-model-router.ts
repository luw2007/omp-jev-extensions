import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CONFIG_PATH = join(homedir(), ".omp", "agent", "jev-model-router.json");
const DEFAULT_JEV_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_JEV_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 10_000;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const ROUTABLE_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface RouterCandidate {
  id: string;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  description: string;
  agent?: string;
  enabled?: boolean;
}

export type RouteMode = "auto" | "tasks" | "off";

export interface RouterState {
  mode: RouteMode;
  modelLocked: boolean;
  modelSource: "default" | "user" | "restored" | "jev";
}

export function isRouteMode(value: string | undefined): value is RouteMode {
  return value === "auto" || value === "tasks" || value === "off";
}

export function parseRouteMode(value: string | undefined, fallback: RouteMode = "tasks"): RouteMode {
  return isRouteMode(value) ? value : fallback;
}

export function resolveInitialMode(environmentValue: string | undefined, configMode: RouteMode | undefined): RouteMode {
  return isRouteMode(environmentValue) ? environmentValue : configMode ?? "tasks";
}

export function shouldRouteSession(state: RouterState): boolean {
  return state.mode === "auto" && !state.modelLocked;
}

export function shouldRouteTasks(state: RouterState): boolean {
  return state.mode === "auto" || state.mode === "tasks";
}

export function setRouteMode(state: RouterState, mode: RouteMode): void {
  state.mode = mode;
  if (mode === "auto") {
    state.modelLocked = false;
    state.modelSource = "default";
  }
}

export function applyModelSelection(
  state: RouterState,
  source: "set" | "cycle" | "restore",
  internalChange = false,
): void {
  if (internalChange) return;
  state.modelLocked = true;
  state.modelSource = source === "restore" ? "restored" : "user";
}

export function isChildSession(header: { parentSession?: string } | null | undefined): boolean {
  return typeof header?.parentSession === "string" && header.parentSession.length > 0;
}

export function routeStatus(state: RouterState): string {
  const main = state.mode !== "auto" ? "off" : state.modelLocked ? "locked" : "auto";
  return `route=${state.mode} main=${main} tasks=${shouldRouteTasks(state) ? "auto" : "off"} modelLock=${state.modelLocked ? "on" : "off"} modelSource=${state.modelSource}`;
}

export interface RouterConfig {
  candidates: RouterCandidate[];
  mode?: RouteMode;
  timeoutMs?: number;
  jevUrl?: string;
  jevModel?: string;
}

interface JevAnswer {
  answers?: {
    selection?: {
      choice?: string;
      confidence?: number;
      probabilities?: Record<string, number>;
    };
  };
}

interface ModelRegistryLike {
  find(provider: string, modelId: string): unknown;
  hasConfiguredAuth(model: unknown): boolean;
}

export interface RoutingContext {
  modelRegistry: ModelRegistryLike;
}

export interface RoutingApi {
  setModel(model: unknown): Promise<boolean>;
  setThinkingLevel(level: ThinkingLevel): void;
}

export function validateConfig(value: unknown): RouterConfig | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Partial<RouterConfig>;
  if (!Array.isArray(raw.candidates)) return undefined;
  const ids = new Set<string>();
  const candidates: RouterCandidate[] = [];
  for (const item of raw.candidates) {
    if (typeof item !== "object" || item === null) return undefined;
    const candidate = item as Partial<RouterCandidate>;
    if (
      typeof candidate.id !== "string" || !candidate.id || ids.has(candidate.id) ||
      typeof candidate.provider !== "string" || !candidate.provider ||
      typeof candidate.model !== "string" || !candidate.model ||
      typeof candidate.description !== "string" || !candidate.description ||
      (candidate.agent !== undefined && (typeof candidate.agent !== "string" || !candidate.agent)) ||
      !ROUTABLE_THINKING_LEVELS.includes(candidate.thinking as (typeof ROUTABLE_THINKING_LEVELS)[number]) ||
      (candidate.enabled !== undefined && typeof candidate.enabled !== "boolean")
    ) return undefined;
    ids.add(candidate.id);
    candidates.push(candidate as RouterCandidate);
  }
  if (candidates.length === 0) return undefined;
  if (raw.mode !== undefined && raw.mode !== "auto" && raw.mode !== "tasks" && raw.mode !== "off") return undefined;
  if (raw.timeoutMs !== undefined && (!Number.isFinite(raw.timeoutMs) || !Number.isInteger(raw.timeoutMs) || raw.timeoutMs <= 0 || raw.timeoutMs > MAX_TIMEOUT_MS)) return undefined;
  if (raw.jevUrl !== undefined && typeof raw.jevUrl !== "string") return undefined;
  if (raw.jevModel !== undefined && typeof raw.jevModel !== "string") return undefined;
  return { candidates, ...(raw.mode === undefined ? {} : { mode: raw.mode }), ...(raw.timeoutMs === undefined ? {} : { timeoutMs: raw.timeoutMs }), ...(raw.jevUrl === undefined ? {} : { jevUrl: raw.jevUrl }), ...(raw.jevModel === undefined ? {} : { jevModel: raw.jevModel }) };
}

export function enabledCandidates(config: RouterConfig, ctx: RoutingContext): Array<{ candidate: RouterCandidate; model: unknown }> {
  const result: Array<{ candidate: RouterCandidate; model: unknown }> = [];
  for (const candidate of config.candidates) {
    if (candidate.enabled === false) continue;
    const model = ctx.modelRegistry.find(candidate.provider, candidate.model);
    if (model && ctx.modelRegistry.hasConfiguredAuth(model)) result.push({ candidate, model });
  }
  return result;
}

export async function chooseCandidate(
  prompt: string,
  candidates: RouterCandidate[],
  apiKey: string,
  config: RouterConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<RouterCandidate | undefined> {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  const criteria = Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate.description]));
  const response = await fetchImpl(config.jevUrl ?? DEFAULT_JEV_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.jevModel ?? DEFAULT_JEV_MODEL,
      state: {
        task: prompt,
        candidates: candidates.map(({ description: _description, ...candidate }) => candidate),
      },
      questions: {
        selection: {
          type: "choice",
          instructions: "Choose the model and thinking level most likely to complete this agent session correctly and efficiently. Use the task content, required reasoning depth, and candidate descriptions. Return one listed candidate.",
          criteria,
        },
      },
    }),
    signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) return undefined;
  const data = await response.json() as JevAnswer;
  const answer = data.answers?.selection;
  if (!answer || typeof answer.choice !== "string" || typeof answer.confidence !== "number" || answer.confidence < 0 || answer.confidence > 1 || !answer.probabilities) return undefined;
  const ids = candidates.map((candidate) => candidate.id).sort();
  if (Object.keys(answer.probabilities).sort().join("\0") !== ids.join("\0")) return undefined;
  const probabilities = Object.values(answer.probabilities);
  if (!probabilities.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) return undefined;
  const total = probabilities.reduce((sum, value) => sum + value, 0);
  if (total < 0.99 || total > 1.01) return undefined;
  return candidates.find((candidate) => candidate.id === answer.choice);
}

export async function routeSession(
  prompt: string,
  ctx: RoutingContext,
  api: RoutingApi,
  config: RouterConfig,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const available = enabledCandidates(config, ctx);
  const selected = await chooseCandidate(prompt, available.map((entry) => entry.candidate), apiKey, config, fetchImpl);
  if (!selected) return false;
  const entry = available.find((item) => item.candidate.id === selected.id);
  if (!entry) return false;
  if (!await api.setModel(entry.model)) return false;
  api.setThinkingLevel(selected.thinking);
  return true;
}

async function loadConfig(path = process.env.JEV_MODEL_ROUTER_CONFIG ?? DEFAULT_CONFIG_PATH): Promise<RouterConfig | undefined> {
  try {
    return validateConfig(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

export async function routeTaskItems(
  items: Array<{ task?: string; agent?: string; routing?: "auto" | "fixed" }>,
  ctx: RoutingContext,
  config: RouterConfig,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await Promise.allSettled(items.map(async (item) => {
    if (typeof item.task !== "string" || !item.task.trim()) return;
    if (item.routing === "fixed") return;
    const available = enabledCandidates(config, ctx)
      .map((entry) => entry.candidate)
      .filter((candidate) => candidate.agent);
    const selected = await chooseCandidate(item.task, available, apiKey, config, fetchImpl);
    if (selected?.agent) item.agent = selected.agent;
  }));
}

export interface RouterRuntimeOptions {
  env?: Record<string, string | undefined>;
  loadConfig?: () => Promise<RouterConfig | undefined>;
  fetchImpl?: typeof fetch;
}

interface ModelSelectEvent {
  source: "set" | "cycle" | "restore";
}

interface ModelSelectCompatibleApi {
  on(event: "model_select", handler: (event: ModelSelectEvent) => void | Promise<void>): () => void;
}

export function createRouterExtension(runtime: RouterRuntimeOptions = {}) {
  return function registerRouter(pi: ExtensionAPI) {
  const env = runtime.env ?? process.env;
  const configLoader = runtime.loadConfig ?? (() => loadConfig(env.JEV_MODEL_ROUTER_CONFIG ?? DEFAULT_CONFIG_PATH));
  const fetchImpl = runtime.fetchImpl ?? fetch;
  let routed = false;
  let internalModelChange = false;
  let modeManuallySet = false;
  let configModeApplied = false;
  let configValue: RouterConfig | undefined;
  const getConfig = async () => {
    if (configValue) return configValue;
    const loaded = await configLoader();
    if (loaded) configValue = loaded;
    return loaded;
  };
  const environmentMode = isRouteMode(env.JEV_MODEL_ROUTING) ? env.JEV_MODEL_ROUTING : undefined;
  const state: RouterState = {
    mode: resolveInitialMode(environmentMode, undefined),
    modelLocked: false,
    modelSource: "default",
  };
  const applyConfigMode = (config: RouterConfig) => {
    if (!configModeApplied && !modeManuallySet && environmentMode === undefined && config.mode !== undefined) {
      state.mode = config.mode;
    }
    configModeApplied = true;
  };

  pi.registerCommand("route", {
    description: "Set Jev routing mode: auto, tasks, off, or status",
    getArgumentCompletions: (prefix) => ["auto", "tasks", "off", "status"]
      .filter((value) => value.startsWith(prefix))
      .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const value = args.trim() || "status";
      if (value === "status") {
        const config = await getConfig();
        if (config) applyConfigMode(config);
        ctx.ui.notify(routeStatus(state));
        return;
      }
      if (value !== "auto" && value !== "tasks" && value !== "off") {
        ctx.ui.notify("usage: /route auto|tasks|off|status", "warning");
        return;
      }
      modeManuallySet = true;
      setRouteMode(state, value);
      if (value === "auto") routed = false;
      ctx.ui.notify(routeStatus(state));
    },
  });

  (pi as unknown as ModelSelectCompatibleApi).on("model_select", (event) => {
    applyModelSelection(state, event.source, internalModelChange);
  });

  pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
    if (isChildSession(ctx.sessionManager.getHeader())) return;
    const config = await getConfig();
    if (!config) return;
    applyConfigMode(config);
    if (routed || !shouldRouteSession(state)) return;
    const apiKey = env.TYPESAFE_API_KEY;
    if (!apiKey) return;
    try {
      internalModelChange = true;
      const changed = await routeSession(event.prompt, ctx, {
        setModel: (model) => pi.setModel(model as Parameters<ExtensionAPI["setModel"]>[0]),
        setThinkingLevel: (level) => pi.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]),
      }, config, apiKey, fetchImpl);
      if (changed) {
        routed = true;
        state.modelSource = "jev";
        return { systemPrompt: ctx.getSystemPrompt() };
      }
    } catch {
      // Fail open: keep the current model and retry routing on the next prompt.
    } finally {
      internalModelChange = false;
    }
  });

  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    if (event.toolName !== "task" && event.toolName !== "functions.task") return;
    const config = await getConfig();
    if (!config) return;
    applyConfigMode(config);
    if (!shouldRouteTasks(state)) return;
    const apiKey = env.TYPESAFE_API_KEY;
    if (!apiKey) return;
    const input = event.input as {
      tasks?: Array<{ task?: string; agent?: string; routing?: "auto" | "fixed" }>;
      task?: string;
      agent?: string;
      routing?: "auto" | "fixed";
    };
    const items = Array.isArray(input.tasks) ? input.tasks : [input];
    await routeTaskItems(items, ctx, config, apiKey, fetchImpl).catch(() => {
      // Fail open: preserve the task's requested agent.
    });
  });
}
