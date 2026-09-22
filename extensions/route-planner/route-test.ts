import assert from "node:assert/strict";
import { validateRoutePlanInvariants, type RoutePlan } from "./route-schema.js";
import { askJevRoutePlan, type RoutePromptContext } from "./route-jev.js";
import { runAcceptanceGate } from "../acceptance-gate/stop-jev.js";

async function runTests() {
  console.log("Running Route Agent Smoke Scenarios...");

  // Scenario 1: Validate acyclic DAG pass
  const validDag: RoutePlan = {
    version: 1,
    mode: "dag",
    rationale: "Step 1 feeds step 2",
    slices: [
      { id: "s1", agent: "fast", taskClass: "routine", dependsOn: [], target: "a", change: "b", acceptance: "c" },
      { id: "s2", agent: "smart", taskClass: "smart", dependsOn: ["s1"], target: "d", change: "e", acceptance: "f" },
    ],
  };
  validateRoutePlanInvariants(validDag);
  console.log("✓ Valid DAG invariant check passed");

  // Scenario 2: Validate cyclic DAG fails
  const cyclicDag: RoutePlan = {
    version: 1,
    mode: "dag",
    rationale: "Cycle",
    slices: [
      { id: "s1", agent: "fast", taskClass: "routine", dependsOn: ["s2"], target: "a", change: "b", acceptance: "c" },
      { id: "s2", agent: "smart", taskClass: "smart", dependsOn: ["s1"], target: "d", change: "e", acceptance: "f" },
    ],
  };
  assert.throws(() => validateRoutePlanInvariants(cyclicDag), /Cyclic dependency detected/);
  console.log("✓ Cycle detection invariant check passed");

  // Scenario 3: Fake Jev mock response (incl. model_* choices)
  const fakeFetch = (async () => {
    return {
      ok: true,
      json: async () => ({
        answers: {
          mode: { choice: "parallel", confidence: 0.95 },
          agent_slice_1: { choice: "scout" },
          agent_slice_2: { choice: "fast" },
          model_slice_1: { choice: "smart" },
          model_slice_2: { choice: "not-a-real-role" },
        },
      }),
      text: async () => "",
    };
  }) as unknown as typeof fetch;

  const ctx: RoutePromptContext = {
    task: "Investigate architecture and update README",
    candidates: [
      { id: "slice_1", target: "doc", change: "inspect code", acceptance: "report", isReadonly: true },
      { id: "slice_2", target: "README", change: "write summary", acceptance: "file updated", isReadonly: false },
    ],
  };

  const plan = await askJevRoutePlan(ctx, fakeFetch);
  assert.equal(plan.mode, "parallel");
  assert.equal(plan.slices.length, 2);
  assert.equal(plan.slices[0].agent, "scout");
  assert.equal(plan.slices[1].agent, "fast");
  assert.equal(plan.slices[0].model, "smart", "scout slice should take Jev's model choice");
  assert.equal(plan.slices[1].model, "fast", "bogus model choice must fall back to fast");
  console.log("✓ Fake-Jev parallel plan + model_ parsing passed");

  // Scenario 4: stop-jev acceptance gate (boolean + tolerant choice + fail-open)
  process.env.TYPESAFE_API_KEY = "dummy-test-key";
  const input = { target: "t", acceptance: "tests green", summary: "ran bun test" };

  const acceptFetch = (async () => ({
    ok: true,
    json: async () => ({ answers: { done: { answer: true, confidence: 0.91, reasoning: "all green" } } }),
  })) as unknown as typeof fetch;
  const accepted = await runAcceptanceGate(input, acceptFetch);
  assert.equal(accepted.accepted, true);
  assert.ok(accepted.confidence >= 0.9);
  console.log("✓ stop-gate accepted path passed");

  const rejectFetch = (async () => ({
    ok: true,
    json: async () => ({ answers: { done: { answer: false, reasoning: "no tests run" } } }),
  })) as unknown as typeof fetch;
  const rejected = await runAcceptanceGate(input, rejectFetch);
  assert.equal(rejected.accepted, false);
  assert.match(rejected.reason, /no tests run/);
  console.log("✓ stop-gate rejected path passed");

  const tolerantFetch = (async () => ({
    ok: true,
    json: async () => ({ answers: { done: { choice: "true", confidence: 0.7 } } }),
  })) as unknown as typeof fetch;
  const tolerated = await runAcceptanceGate(input, tolerantFetch);
  assert.equal(tolerated.accepted, true, "choice='true' must be accepted even when answer field missing");
  console.log("✓ stop-gate tolerant choice parse passed");

  const brokenFetch = (async () => ({
    ok: true,
    json: async () => ({ answers: { done: {} } }),
  })) as unknown as typeof fetch;
  const failedOpen = await runAcceptanceGate(input, brokenFetch);
  assert.equal(failedOpen.accepted, true, "malformed answer must fail open");
  assert.equal(failedOpen.confidence, 0, "fail-open must carry zero confidence, not 1");
  console.log("✓ stop-gate fail-open + zero confidence passed");

  console.log("\nAll smoke scenarios verified successfully!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

// OMP scans every .ts in the extensions tree; this module is imported by
// route-agent.ts and does not register tools itself. No-op factory.
export default function () {}
