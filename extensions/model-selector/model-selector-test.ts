import assert from "node:assert/strict";
import { trustIq, BenchmarkSource, MIN_IQ_SAMPLES } from "./benchmark.js";
import {
  measureSpeed,
  summarizeTrials,
  NeedLongerPrompt,
  MIN_OUTPUT_TOKENS,
} from "./speed-benchmark.js";
import { selectModel, type ModelCandidate } from "./select.js";

async function run() {
  // --- IQ trust rules ---
  assert.equal(
    trustIq({ iq: 80, samples: 2, effort: "high" }, "high"),
    undefined,
    "samples below threshold must be unknown",
  );
  assert.equal(
    trustIq({ iq: 80, samples: MIN_IQ_SAMPLES, effort: "high" }, "medium"),
    undefined,
    "different effort must not compare",
  );
  assert.equal(
    trustIq({ iq: 80, samples: MIN_IQ_SAMPLES, effort: "high" }, "high"),
    80,
  );
  console.log("✓ IQ trust: sample floor + same-effort gate");

  // --- benchmark source fetch + cache ---
  const body = {
    points: [
      { model: "m", effort: "high", iq: 72, total: 120, source_updated_at: "2026-09-01" },
      { model: "m", effort: "high", iq: 99, total: 1, source_updated_at: "2026-09-01" },
    ],
  };
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    return { ok: true, json: async () => body };
  }) as unknown as typeof fetch;
  const src = new BenchmarkSource({ url: "http://x", cacheTtlMs: 999_999 });
  const points = (await src.points(fakeFetch))!;
  await src.points(fakeFetch);
  assert.equal(calls, 1, "second call must be served from cache");
  const hit = src.lookup(points, "m", "high")!;
  assert.equal(hit.iq, 72, "parser keeps rows; trust rule decides which is usable");
  console.log("✓ benchmark source: parse + cache + lookup");

  // --- speed harness: decode time excludes TTFT ---
  // Timing on the wire is in MILLISECONDS on the final message_end event.
  const ndjson = (msg: Record<string, unknown>) =>
    [
      JSON.stringify({ type: "turn_start" }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", ...msg } }),
      "",
    ].join("\n");
  const fakeExec = (async () => ({
    stdout: ndjson({
      content: [{ type: "text", text: "x".repeat(800) }],
      ttft: 2000,
      duration: 12000,
      usage: { output: 800, reasoningTokens: 0 },
    }),
    stderr: "",
  })) as unknown as typeof import("node:child_process").execFile;
  const trials = await measureSpeed({
    model: "p/m",
    prompt: "write a long thing",
    thinking: "off",
    trials: 3,
    execImpl: fakeExec,
  });
  assert.equal(trials.length, 3);
  assert.ok(Math.abs(trials[0].tokPerSec - 80) < 1e-9, "800 tokens / 10s decode = 80 tps");
  const s = summarizeTrials(trials);
  assert.equal(s.medianTokPerSec, 80);
  console.log("✓ speed harness: NDJSON parsed, TTFT excluded, steady-state tps");

  // --- speed harness: short output rejected ---
  const shortExec = (async () => ({
    stdout: ndjson({ ttft: 1000, duration: 3000, usage: { output: 50 } }),
    stderr: "",
  })) as unknown as typeof import("node:child_process").execFile;
  await assert.rejects(
    measureSpeed({ model: "p/m", prompt: "x", trials: 2, execImpl: shortExec }),
    (err: unknown) => err instanceof NeedLongerPrompt,
  );
  console.log(`✓ speed harness: output < ${MIN_OUTPUT_TOKENS} forces longer prompt`);

  // --- wire-level no-thinking check: billed reasoning tokens betray thinking ---
  const thinkingExec = (async () => ({
    stdout: ndjson({
      content: [{ type: "text", text: "x".repeat(400) }],
      ttft: 1000,
      duration: 3000,
      usage: { output: 400, reasoningTokens: 128 },
    }),
    stderr: "",
  })) as unknown as typeof import("node:child_process").execFile;
  await assert.rejects(
    measureSpeed({ model: "p/m", prompt: "x", execImpl: thinkingExec }),
    /reasoning/,
  );
  console.log("✓ speed harness: bare-ID != no-thinking, reasoningTokens checked");

  // --- policy: faster but unqualified models cannot win or become fallbacks ---
  const fastCandidates: ModelCandidate[] = [
    { id: "luna-low", role: "fast", billing: "subscription", quotaRemaining: 60, tokPerSec: 100, targetEffort: "low", benchmarkPoint: { iq: 7, samples: 50, effort: "low" } },
    { id: "luna-medium", role: "fast", billing: "subscription", quotaRemaining: 60, tokPerSec: 90, targetEffort: "medium", benchmarkPoint: { iq: 33, samples: 50, effort: "medium" } },
    { id: "luna-high", role: "fast", billing: "subscription", quotaRemaining: 60, tokPerSec: 80, targetEffort: "high", benchmarkPoint: { iq: 76, samples: 50, effort: "high" } },
    { id: "luna-xhigh", role: "fast", billing: "subscription", quotaRemaining: 60, tokPerSec: 60, targetEffort: "xhigh", benchmarkPoint: { iq: 86, samples: 50, effort: "xhigh" } },
    { id: "sol-medium", role: "fast", billing: "subscription", quotaRemaining: 60, tokPerSec: 10, targetEffort: "medium", benchmarkPoint: { iq: 95, samples: 50, effort: "medium" } },
  ];
  const fastPick = selectModel({ role: "fast", candidates: fastCandidates });
  assert.equal(fastPick.primary?.id, "luna-xhigh", "fastest qualified model wins");
  assert.deepEqual(fastPick.fallback.map(c => c.id), ["sol-medium"]);
  assert.deepEqual(fastPick.eliminated.map(e => e.id), ["luna-low", "luna-medium", "luna-high"]);
  console.log("✓ policy fast: IQ >=80 applies to primary and fallback");

  // An IQ floor must apply to the primary and every fallback.
  const guarded: ModelCandidate[] = [
    { id: "qualified", role: "judge", billing: "subscription", quotaRemaining: 60, tokPerSec: 40, targetEffort: "xhigh", benchmarkPoint: { iq: 86, samples: 50, effort: "xhigh" } },
    { id: "luna-high", role: "judge", billing: "subscription", quotaRemaining: 60, tokPerSec: 90, targetEffort: "high", benchmarkPoint: { iq: 76, samples: 50, effort: "high" } },
    { id: "wrong-effort", role: "judge", billing: "subscription", quotaRemaining: 60, tokPerSec: 85, targetEffort: "medium", benchmarkPoint: { iq: 95, samples: 50, effort: "xhigh" } },
    { id: "unknown", role: "judge", billing: "subscription", quotaRemaining: 60, tokPerSec: 80, targetEffort: "xhigh" },
    { id: "untrusted-samples", role: "judge", billing: "subscription", quotaRemaining: 60, tokPerSec: 95, targetEffort: "xhigh", iq: 99, benchmarkPoint: { iq: 99, samples: 2, effort: "xhigh" } },
  ];
  const guardedPick = selectModel({ role: "judge", candidates: guarded });
  assert.equal(guardedPick.primary?.id, "qualified");
  assert.deepEqual(guardedPick.fallback, []);
  assert.deepEqual(guardedPick.eliminated.map(e => e.id), ["luna-high", "wrong-effort", "unknown", "untrusted-samples"]);
  assert.equal(selectModel({ role: "fast", candidates: guarded.slice(1) }).primary, undefined);
  console.log("✓ policy: judge and fast reject low/unknown IQ");

  // --- policy: billing gate before ranking ---
  const gated: ModelCandidate[] = [
    { id: "no-quota", role: "smart", billing: "subscription", quotaRemaining: 0, targetEffort: "high", benchmarkPoint: { iq: 99, samples: 50, effort: "high" } },
    { id: "pool-busy", role: "smart", billing: "shared_pool", load: 140, targetEffort: "high", benchmarkPoint: { iq: 95, samples: 50, effort: "high" } },
    { id: "usable", role: "smart", billing: "subscription", quotaRemaining: 40, targetEffort: "high", benchmarkPoint: { iq: 80, samples: 50, effort: "high" } },
  ];
  const gate = selectModel({ role: "smart", candidates: gated });
  assert.equal(gate.primary?.id, "usable");
  assert.equal(gate.eliminated.length, 2);
  console.log("✓ policy: depleted subscription and saturated pool eliminated first");

  // --- policy: load-bearing role ranks by IQ, speed ignored ---
  const smartCandidates: ModelCandidate[] = [
    { id: "slow-smart", role: "smart", billing: "subscription", quotaRemaining: 30, tokPerSec: 5, targetEffort: "high", benchmarkPoint: { iq: 90, samples: 50, effort: "high" } },
    { id: "fast-smart", role: "smart", billing: "subscription", quotaRemaining: 30, tokPerSec: 80, targetEffort: "high", benchmarkPoint: { iq: 85, samples: 50, effort: "high" } },
  ];
  const smartPick = selectModel({ role: "smart", candidates: smartCandidates });
  assert.equal(smartPick.primary?.id, "slow-smart", "IQ wins for smart even when slower");
  assert.equal(selectModel({ role: "smart", candidates: [{ id: "low-smart", role: "smart", billing: "subscription", quotaRemaining: 30, targetEffort: "high", benchmarkPoint: { iq: 79, samples: 50, effort: "high" } }] }).primary, undefined);
  assert.equal(selectModel({ role: "plan", candidates: [{ id: "unknown-plan", role: "plan", billing: "subscription", quotaRemaining: 30, targetEffort: "high" }] }).primary, undefined);
  console.log("✓ policy smart: IQ ranking ignores speed");

  console.log("\nAll model-selector checks passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
