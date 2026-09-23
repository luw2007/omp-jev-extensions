import assert from "node:assert/strict";
import {
  applyModelSelection,
  chooseCandidate,
  enabledCandidates,
  isChildSession,
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

  console.log("All all-model-router checks passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

export default function () {}
