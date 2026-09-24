import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import assert from "node:assert/strict";
import {
  applyModelSelection,
  chooseCandidate,
  createRouterExtension,
  enabledCandidates,
  isChildSession,
  isRestoredSession,
  modelKey,
  observeModelSelection,
  parseRouteMode,
  resolveInitialMode,
  routeSession,
  routeStatus,
  routeTaskItems,
  setRouteMode,
  shouldRouteSession,
  shouldRouteTasks,
  validateConfig,
  type RouterConfig,
  type RouterState,
} from "./all-model-router.js";

const config: RouterConfig = {
  candidates: [
    { id: "fast", provider: "p", model: "fast", thinking: "high", description: "routine work" },
    { id: "smart", provider: "p", model: "smart", thinking: "xhigh", description: "complex work" },
  ],
};

async function run() {
  assert.equal(validateConfig({ candidates: [] }), undefined);
  assert.equal(validateConfig({ ...config, mode: "bad" }), undefined);
  assert.equal(validateConfig({ ...config, mode: "tasks" })?.mode, "tasks");
  assert.equal(validateConfig({ candidates: [{ id: "x", provider: "p", model: "m", thinking: "bad", description: "x" }] }), undefined);
  assert.equal(validateConfig({ ...config, timeoutMs: 10_001 }), undefined);
  assert.equal(validateConfig({ ...config, timeoutMs: 10_000 })?.timeoutMs, 10_000);
  assert.equal(validateConfig({ ...config, timeoutMs: 1.5 }), undefined);
  assert.equal(validateConfig(config)?.candidates.length, 2);
  assert.equal(isChildSession(undefined), false);
  assert.equal(isChildSession({}), false);
  assert.equal(isChildSession({ parentSession: "/tmp/parent.jsonl" }), true);
  assert.equal(isRestoredSession([{ type: "model_change" }]), false);
  assert.equal(isRestoredSession([{ type: "message" }]), true);
  assert.equal(modelKey({ provider: "p", id: "m" }), "p/m");
  const observedState: RouterState = { mode: "auto", modelLocked: false, modelSource: "default" };
  let observed = observeModelSelection(observedState, undefined, "p/a");
  assert.equal(observedState.modelLocked, false);
  observed = observeModelSelection(observedState, observed, "p/b");
  assert.equal(observedState.modelLocked, true);
  assert.equal(observedState.modelSource, "user");
  observedState.modelLocked = false;
  observedState.modelSource = "jev";
  observeModelSelection(observedState, observed, "p/c", true);
  assert.equal(observedState.modelLocked, false);

  assert.equal(resolveInitialMode("auto", "off"), "auto");
  assert.equal(resolveInitialMode("invalid", "off"), "off");
  assert.equal(resolveInitialMode(undefined, "auto"), "auto");
  assert.equal(resolveInitialMode(undefined, undefined), "tasks");
  const state: RouterState = { mode: parseRouteMode(undefined), modelLocked: false, modelSource: "default" };
  assert.equal(state.mode, "tasks");
  assert.equal(shouldRouteSession(state), false);
  assert.equal(shouldRouteTasks(state), true);
  state.modelLocked = true;
  state.modelSource = "user";
  setRouteMode(state, "auto");
  assert.deepEqual(state, { mode: "auto", modelLocked: false, modelSource: "default" });
  assert.equal(shouldRouteSession(state), true);
  assert.match(routeStatus(state), /route=auto main=auto tasks=auto modelLock=off/);
  applyModelSelection(state, "set");
  assert.deepEqual(state, { mode: "auto", modelLocked: true, modelSource: "user" });
  assert.equal(shouldRouteSession(state), false);
  applyModelSelection(state, "restore");
  assert.equal(state.modelSource, "restored");
  applyModelSelection(state, "cycle", true);
  assert.equal(state.modelSource, "restored", "router-owned model changes must not create a user lock");
  setRouteMode(state, "off");
  assert.equal(shouldRouteSession(state), false);
  assert.equal(shouldRouteTasks(state), false);

  const modelById = new Map([
    ["p/fast", { provider: "p", id: "fast" }],
    ["p/smart", { provider: "p", id: "smart" }],
  ]);
  const ctx = {
    modelRegistry: {
      find: (provider: string, model: string) => modelById.get(`${provider}/${model}`),
      hasConfiguredAuth: (model: unknown) => (model as { id: string }).id !== "fast",
    },
  };
  assert.deepEqual(enabledCandidates(config, ctx).map((entry) => entry.candidate.id), ["smart"]);

  let calls = 0;
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    calls += 1;
    const request = JSON.parse(String(init.body));
    assert.equal(request.state.task, "review a concurrency bug");
    assert.deepEqual(Object.keys(request.questions.selection.criteria).sort(), ["fast", "smart"]);
    return {
      ok: true,
      json: async () => ({ answers: { selection: { choice: "smart", confidence: 0.9, probabilities: { fast: 0.1, smart: 0.9 } } } }),
    };
  }) as unknown as typeof fetch;
  assert.equal((await chooseCandidate("review a concurrency bug", config.candidates, "key", config, fakeFetch))?.id, "smart");
  assert.equal(calls, 1);

  const one = await chooseCandidate("small task", [config.candidates[0]!], "key", config, fakeFetch);
  assert.equal(one?.id, "fast");
  assert.equal(calls, 1, "one candidate does not call Jev");

  let chosenModel: unknown;
  let thinking: string | undefined;
  const routed = await routeSession(
    "review a concurrency bug",
    {
      modelRegistry: {
        find: (provider: string, model: string) => modelById.get(`${provider}/${model}`),
        hasConfiguredAuth: () => true,
      },
    },
    {
      setModel: async (model) => { chosenModel = model; return true; },
      setThinkingLevel: (level) => { thinking = level; },
    },
    config,
    "key",
    fakeFetch,
  );
  assert.equal(routed, true);
  assert.deepEqual(chosenModel, { provider: "p", id: "smart" });
  assert.equal(thinking, "xhigh");

  const taskConfig: RouterConfig = {
    candidates: config.candidates.map((candidate) => ({ ...candidate, agent: `task-${candidate.id}` })),
  };
  const taskItems = [
    { task: "small edit", agent: "fast" },
    { task: "review architecture", agent: "smart" },
    { task: "keep explicit reviewer", agent: "reviewer", routing: "fixed" as const },
  ];
  const taskFetch = (async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    assert.ok(["small edit", "review architecture"].includes(request.state.task));
    return {
      ok: true,
      json: async () => ({ answers: { selection: { choice: "smart", confidence: 0.9, probabilities: { fast: 0.1, smart: 0.9 } } } }),
    };
  }) as unknown as typeof fetch;
  await routeTaskItems(taskItems, {
    modelRegistry: {
      find: (provider: string, model: string) => modelById.get(`${provider}/${model}`),
      hasConfiguredAuth: () => true,
    },
  }, taskConfig, "key", taskFetch);
  assert.deepEqual(taskItems.map((item) => item.agent), ["task-smart", "task-smart", "reviewer"]);

  const partialItems = [{ task: "fails", agent: "fast" }, { task: "succeeds", agent: "smart" }];
  const partialFetch = (async (_url: string, init: RequestInit) => {
    const task = JSON.parse(String(init.body)).state.task;
    if (task === "fails") throw new Error("network down");
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      ok: true,
      json: async () => ({ answers: { selection: { choice: "fast", confidence: 0.8, probabilities: { fast: 0.8, smart: 0.2 } } } }),
    };
  }) as unknown as typeof fetch;
  await routeTaskItems(partialItems, {
    modelRegistry: {
      find: (provider: string, model: string) => modelById.get(`${provider}/${model}`),
      hasConfiguredAuth: () => true,
    },
  }, taskConfig, "key", partialFetch);
  assert.deepEqual(partialItems.map((item) => item.agent), ["fast", "task-fast"], "one failed item must not release the batch before other routes settle");

  const invalidFetch = (async () => ({
    ok: true,
    json: async () => ({ answers: { selection: { choice: "missing", confidence: 1, probabilities: { fast: 0.5, smart: 0.5 } } } }),
  })) as unknown as typeof fetch;
  assert.equal(await chooseCandidate("x", config.candidates, "key", config, invalidFetch), undefined);

  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  let routeCommand: { handler: (args: string, ctx: { ui: { notify(message: string): void } }) => Promise<void> } | undefined;
  let setModelCalls = 0;
  let currentMainModel = { provider: "p", id: "initial" };
  const handlerApi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, handler); return () => {}; },
    registerCommand: (name: string, command: typeof routeCommand) => { if (name === "route") routeCommand = command; },
    setModel: async (model: unknown) => {
      setModelCalls += 1;
      currentMainModel = model as { provider: string; id: string };
      return true;
    },
    setThinkingLevel: () => {},
  } as unknown as ExtensionAPI;
  let handlerFetchCalls = 0;
  const handlerFetch = (async () => {
    handlerFetchCalls += 1;
    return {
      ok: true,
      json: async () => ({ answers: { selection: { choice: "smart", confidence: 0.9, probabilities: { fast: 0.1, smart: 0.9 } } } }),
    };
  }) as unknown as typeof fetch;
  createRouterExtension({
    env: { TYPESAFE_API_KEY: "key", JEV_MODEL_ROUTING: "auto" },
    loadConfig: async () => config,
    fetchImpl: handlerFetch,
  })(handlerApi);
  const mainContext = {
    sessionManager: { getHeader: () => ({ type: "session", id: "main" }), getEntries: () => [] },
    modelRegistry: { find: (provider: string, model: string) => modelById.get(`${provider}/${model}`), hasConfiguredAuth: () => true },
    get model() { return currentMainModel; },
    getSystemPrompt: () => "rebuilt prompt",
  };
  await handlers.get("session_start")!({}, mainContext);
  const beforeStart = handlers.get("before_agent_start")!;
  assert.deepEqual(await beforeStart({ prompt: "main task" }, mainContext), { systemPrompt: "rebuilt prompt" });
  assert.equal(setModelCalls, 1);
  assert.equal(handlerFetchCalls, 1);
  await beforeStart({ prompt: "second turn" }, mainContext);
  assert.equal(setModelCalls, 1, "auto routing selects the main model once");

  const childHandlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  let childSetModelCalls = 0;
  createRouterExtension({
    env: { TYPESAFE_API_KEY: "key", JEV_MODEL_ROUTING: "auto" },
    loadConfig: async () => config,
    fetchImpl: handlerFetch,
  })({
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { childHandlers.set(name, handler); return () => {}; },
    registerCommand: () => {},
    setModel: async () => { childSetModelCalls += 1; return true; },
    setThinkingLevel: () => {},
  } as unknown as ExtensionAPI);
  await childHandlers.get("before_agent_start")!({ prompt: "child task" }, {
    ...mainContext,
    sessionManager: { getHeader: () => ({ type: "session", id: "child", parentSession: "/tmp/main.jsonl" }) },
  });
  assert.equal(childSetModelCalls, 0, "subagents keep the model selected by task routing");

  const restoredHandlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  let restoredSetModelCalls = 0;
  createRouterExtension({
    env: { TYPESAFE_API_KEY: "key", JEV_MODEL_ROUTING: "auto" },
    loadConfig: async () => config,
    fetchImpl: handlerFetch,
  })({
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { restoredHandlers.set(name, handler); return () => {}; },
    registerCommand: () => {},
    setModel: async () => { restoredSetModelCalls += 1; return true; },
    setThinkingLevel: () => {},
  } as unknown as ExtensionAPI);
  const restoredContext = {
    ...mainContext,
    sessionManager: { getHeader: () => ({ type: "session", id: "restored" }), getEntries: () => [{ type: "message" }] },
  };
  await restoredHandlers.get("session_start")!({}, restoredContext);
  await restoredHandlers.get("before_agent_start")!({ prompt: "resume" }, restoredContext);
  assert.equal(restoredSetModelCalls, 0, "restored sessions keep their restored main model");
  await routeCommand!.handler("auto", { ui: { notify: () => {} } });
  currentMainModel = { provider: "p", id: "manual" };
  await handlers.get("session_switch")!({ reason: "resume" }, mainContext);
  await beforeStart({ prompt: "resumed in process" }, mainContext);
  assert.equal(setModelCalls, 1, "session_switch resume restores the manual lock even when the model key matches");

  const notices: string[] = [];
  assert.ok(routeCommand);
  await routeCommand!.handler("auto", { ui: { notify: (message) => notices.push(message) } });
  assert.match(notices.at(-1)!, /route=auto/);
  currentMainModel = { provider: "p", id: "manual-2" };
  await beforeStart({ prompt: "manual lock" }, mainContext);
  assert.equal(setModelCalls, 1, "a changed model snapshot locks automatic main routing without model_select support");
  await routeCommand!.handler("auto", { ui: { notify: (message) => notices.push(message) } });
  await beforeStart({ prompt: "auto again" }, mainContext);
  assert.equal(setModelCalls, 2, "/route auto clears the manual lock");

  console.log("All all-model-router checks passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

export default function () {}
