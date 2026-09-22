import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractRequestedSlices,
  extractSpawnedIds,
  readSubagentOutcome,
  auditSession,
} from "./task-routing-audit.js";

function ndjson(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

async function run() {
  const root = mkdtempSync(join(tmpdir(), "task-routing-audit-test-"));

  // --- Scenario 1: single-slice task call, requested "fast", subagent
  // transcript shows the hook actually ran a different model, then stopped
  // cleanly. This is the exact shape verified against a real session.
  // agentId and jobId are DELIBERATELY DIFFERENT here (as they are minted
  // independently by `task/index.ts`) to catch the id-conflation bug: the
  // transcript file is keyed by agentId, never jobId.
  const singleSessionFile = join(root, "single-session.jsonl");
  writeFileSync(
    singleSessionFile,
    ndjson([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_1",
              name: "task",
              arguments: { tasks: [{ agent: "fast", task: "Fix the credential layout bug in the shared table row" }] },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "task",
          content: [{ type: "text", text: "Spawned agent `CloudCredentialLayout` (job `job-9f31`). Its result auto-delivers on yield..." }],
        },
      },
    ]),
  );
  const singleSessionDir = join(root, "single-session");
  mkdirSync(singleSessionDir);
  writeFileSync(
    join(singleSessionDir, "CloudCredentialLayout.jsonl"),
    ndjson([
      { type: "model_change", timestamp: "2026-09-21T09:28:40.000Z", model: "gcloud/google/gemini-3.8-flash-high", role: "task-google" },
      { type: "thinking_level_change", timestamp: "2026-09-21T09:28:41.000Z", thinkingLevel: "high" },
      { type: "message", message: { role: "assistant", stopReason: "toolUse" } },
      { type: "message", message: { role: "toolResult", isError: false } },
      { type: "message", message: { role: "assistant", stopReason: "stop" } },
    ]),
  );

  const slices = extractRequestedSlices(singleSessionFile);
  assert.equal(slices.length, 1);
  assert.equal(slices[0]!.requestedAgent, "fast", "must read the pre-mutation request, not any post-mutation value");
  assert.equal(slices[0]!.toolCallId, "call_1");
  console.log("✓ extractRequestedSlices reads the model's original pre-mutation agent field");

  const spawned = extractSpawnedIds(singleSessionFile, "call_1");
  assert.deepEqual(spawned, [{ agentId: "CloudCredentialLayout", jobId: "job-9f31" }]);
  console.log("✓ extractSpawnedIds parses the single-spawn 'Spawned agent `X` (job `Y`)' format, keeping agentId and jobId distinct");

  const outcome = readSubagentOutcome(singleSessionFile, "CloudCredentialLayout");
  assert.equal(outcome.transcriptFound, true, "transcript lookup must use agentId, never jobId — job-9f31.jsonl does not exist");
  assert.equal(outcome.modelChanges.length, 1);
  assert.equal(outcome.modelChanges[0]!.model, "gcloud/google/gemini-3.8-flash-high");
  assert.equal(outcome.finalThinkingLevel, "high");
  assert.equal(outcome.finalStopReason, "stop");
  assert.equal(outcome.hadToolError, false);
  console.log("✓ readSubagentOutcome recovers the ACTUAL post-mutation model and thinking level from the spawned transcript, keyed by agentId");

  const audited = auditSession(singleSessionFile);
  assert.equal(audited.length, 1);
  assert.equal(audited[0]!.slice.requestedAgent, "fast");
  assert.equal(audited[0]!.agentId, "CloudCredentialLayout");
  assert.equal(audited[0]!.jobId, "job-9f31");
  assert.equal(audited[0]!.finalModel, "gcloud/google/gemini-3.8-flash-high");
  assert.equal(audited[0]!.finalThinkingLevel, "high");
  assert.equal(audited[0]!.jevChoice, null, "Jev's own decision is permanently unavailable, must never be fabricated");
  assert.equal(audited[0]!.jevConfidence, null);
  console.log("✓ auditSession end-to-end: requested tier + actual model + thinking + jevChoice explicitly null, never guessed");

  // --- Scenario 2: a slice whose spawned job errored and aborted.
  const abortedSessionFile = join(root, "aborted-session.jsonl");
  writeFileSync(
    abortedSessionFile,
    ndjson([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call_2", name: "task", arguments: { tasks: [{ agent: "fast", task: "retry the layout patch" }] } },
          ],
        },
      },
      {
        type: "message",
        message: { role: "toolResult", toolCallId: "call_2", toolName: "task", content: [{ type: "text", text: "Spawned agent `CloudCredentialLayout-2` (job `job-77aa`)." }] },
      },
    ]),
  );
  const abortedSessionDir = join(root, "aborted-session");
  mkdirSync(abortedSessionDir);
  writeFileSync(
    join(abortedSessionDir, "CloudCredentialLayout-2.jsonl"),
    ndjson([
      { type: "model_change", timestamp: "2026-09-21T09:30:00.000Z", model: "gcloud/google/gemini-3.8-flash-high" },
      { type: "message", message: { role: "toolResult", isError: true } },
      { type: "message", message: { role: "assistant", stopReason: "aborted" } },
    ]),
  );
  const abortedAudit = auditSession(abortedSessionFile);
  assert.equal(abortedAudit[0]!.finalStopReason, "aborted");
  assert.equal(abortedAudit[0]!.hadToolError, true, "must surface a tool error even though the run technically produced output");
  console.log("✓ auditSession surfaces aborted + hadToolError, distinguishing it from a clean stop");

  // --- Scenario 3: multi-spawn bullet-list format with distinct agentId and
  // jobId per line, plus an unrelated backtick-quoted bullet that lacks the
  // "(job `...`)" suffix and must NEVER be counted as a spawn. A missing
  // subagent transcript must fail open (found:false), never throw.
  const multiSessionFile = join(root, "multi-session.jsonl");
  writeFileSync(
    multiSessionFile,
    ndjson([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_3",
              name: "task",
              arguments: {
                tasks: [
                  { agent: "scout", task: "find the intake page" },
                  { agent: "scout", task: "find the credential page" },
                ],
              },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call_3",
          toolName: "task",
          content: [{
            type: "text",
            text:
              "Spawned 2 background agents using scout. Each result auto-delivers on yield unless a settled `hub jobs`/`wait` snapshot consumes it first.\n" +
              "- `IntakeCardScout` (job `job-101`)\n" +
              "- `CredentialsPageScout` (job `job-102`)",
          }],
        },
      },
    ]),
  );
  const multiSpawned = extractSpawnedIds(multiSessionFile, "call_3");
  assert.deepEqual(multiSpawned, [
    { agentId: "IntakeCardScout", jobId: "job-101" },
    { agentId: "CredentialsPageScout", jobId: "job-102" },
  ]);
  console.log("✓ extractSpawnedIds parses the multi-spawn bullet-list format and ignores the unrelated `hub jobs`/`wait` mention (no trailing '(job ...)')");

  const missingOutcome = readSubagentOutcome(multiSessionFile, "IntakeCardScout");
  assert.equal(missingOutcome.transcriptFound, false, "a missing subagent transcript must fail open, not throw");
  assert.deepEqual(missingOutcome.modelChanges, []);
  console.log("✓ readSubagentOutcome fails open when the subagent transcript file does not exist");

  const multiAudit = auditSession(multiSessionFile);
  assert.equal(multiAudit.length, 2, "both requested slices from the batch must be reported even though only one job maps 1:1");
  assert.equal(multiAudit[0]!.agentId, "IntakeCardScout", "slice 0 must pair positionally with spawned[0], not always spawned[0] regardless of index");
  assert.equal(multiAudit[0]!.jobId, "job-101");
  assert.equal(multiAudit[1]!.agentId, "CredentialsPageScout", "slice 1 must pair with spawned[1], not be mislabeled with slice 0's job");
  assert.equal(multiAudit[1]!.jobId, "job-102");
  assert.equal(multiAudit[0]!.pairingNote, null);
  assert.equal(multiAudit[1]!.pairingNote, null);
  console.log("✓ auditSession pairs every requested slice with its OWN positional agentId+jobId, not just spawned[0] for the whole batch");

  // --- Scenario 4: batch size the model requested does not match the id-pair
  // count the toolResult text actually lists (e.g. a parse miss, or a
  // partial spawn). Must report agentId/jobId:null + an explicit pairingNote
  // for every affected slice, never guess a pairing.
  const mismatchSessionFile = join(root, "mismatch-session.jsonl");
  writeFileSync(
    mismatchSessionFile,
    ndjson([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_4",
              name: "task",
              arguments: {
                tasks: [
                  { agent: "scout", task: "task one" },
                  { agent: "scout", task: "task two" },
                  { agent: "scout", task: "task three" },
                ],
              },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call_4",
          toolName: "task",
          content: [{ type: "text", text: "Spawned 3 background agents using scout. Each result auto-delivers on yield...\n- `OnlyOneListed` (job `job-only-1`)" }],
        },
      },
    ]),
  );
  const mismatchAudit = auditSession(mismatchSessionFile);
  assert.equal(mismatchAudit.length, 3);
  for (const row of mismatchAudit) {
    assert.equal(row.agentId, null, "a batch-size mismatch must never guess spawned[0] for slices it cannot positionally pair");
    assert.equal(row.jobId, null);
    assert.match(row.pairingNote ?? "", /requested 3 slice\(s\) but toolResult text listed 1 job id\(s\)/u);
  }
  console.log("✓ auditSession reports agentId/jobId:null + pairingNote instead of guessing when batch size and id-pair count disagree");

  // --- Scenario 5: a bare backtick-quoted token with no "(job ...)" suffix
  // must never be mistaken for a spawn, even when it happens to make the
  // count match the batch size by coincidence.
  const falsePositiveSessionFile = join(root, "false-positive-session.jsonl");
  writeFileSync(
    falsePositiveSessionFile,
    ndjson([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call_5", name: "task", arguments: { tasks: [{ agent: "fast", task: "one task" }] } },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call_5",
          toolName: "task",
          content: [{ type: "text", text: "Note: run `hub jobs` afterwards to check status." }],
        },
      },
    ]),
  );
  const falsePositiveSpawned = extractSpawnedIds(falsePositiveSessionFile, "call_5");
  assert.deepEqual(falsePositiveSpawned, [], "a backtick-quoted token without the trailing '(job ...)' must never be treated as a spawn");
  console.log("✓ extractSpawnedIds ignores backtick-quoted text that lacks the '(job ...)' suffix, even when it would coincidentally match batch size");

  rmSync(root, { recursive: true, force: true });
  console.log("\nAll task-routing-audit scenarios verified successfully!");
}
run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

// No-op factory: this is a standalone offline test, not an extension entry.
export default function () {}
