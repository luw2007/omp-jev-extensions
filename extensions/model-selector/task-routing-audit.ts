// Read-only correlation script: what agent tier did the model request for a
// `task` dispatch, and what actually ran?
//
// Scope, deliberately narrow: `~/.omp/agent/extensions/subagent-capacity.ts`
// (the hook that intercepts `task`/`fast`/`smart` dispatches and calls Jev to
// pick a concrete provider/model/thinking candidate) lives in a different,
// private repository and writes no audit log of its own. This script does
// NOT modify that hook, does not reconstruct its Jev request/response, and
// does not claim to recover its confidence or probabilities — those are
// permanently unavailable without a change to that private repo. It only
// reads session transcripts that already exist on disk and reports what is
// observable from them:
//
//   requestedAgent  — the `agent` field on the slice exactly as the model's
//                      own persisted `toolCall.arguments` shows it. This is
//                      the PRE-mutation value: the model's own request, not
//                      necessarily what the hook picked. Verified against a
//                      real session on 2026-09-22: a slice requested with
//                      `agent:"fast"` is later observed executing on a
//                      completely different provider/model in its own
//                      subagent transcript, which is exactly the hook doing
//                      its job — so this field is "what was asked for", full
//                      stop.
//   actualModel...  — read from the SPAWNED subagent's OWN transcript file
//                      (`<sessionDir>/<sessionStem>/<AgentId>.jsonl` — keyed
//                      by the AGENT id, not the job id; confirmed against
//                      the OMP internal URL registry and the task executor's
//                      transcript path build),
//                      specifically its `model_change` and
//                      `thinking_level_change` events. This is the only
//                      place the real post-mutation provider/model/thinking
//                      is observable at all.
//   outcome         — the spawned subagent's own final assistant message
//                      `stopReason`, plus whether any tool result in its
//                      transcript ever carried `isError:true`. A `toolUse`
//                      stop reason means the transcript's last captured
//                      message ended mid-tool-call; it is NOT evidence of
//                      either success or failure on its own.
//
// A deliberately unverified field is left out entirely rather than guessed:
// `toolResult.details.progress[].agent` on the PARENT session's own `task`
// toolResult was seen once with a value that did not match any request in
// the same batch, and its exact semantics were not confirmed against source
// before this script was written. Do not add it back without first reading
// what populates it.
//
// Usage: bun run task-routing-audit.ts <path/to/session.jsonl> [...more]
// Output: one JSON object per requested slice, newline-delimited, to stdout.

import { readFileSync, existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface SessionMessageEntry {
  type: "message";
  message: {
    role: string;
    toolCallId?: string;
    toolName?: string;
    stopReason?: string;
    isError?: boolean;
    content?: unknown;
  };
}

interface ModelChangeEntry {
  type: "model_change";
  timestamp: string;
  model: string;
  role?: string;
}

interface ThinkingLevelChangeEntry {
  type: "thinking_level_change";
  timestamp: string;
  thinkingLevel: string;
}

export interface RequestedSlice {
  readonly parentSessionFile: string;
  readonly toolCallId: string;
  readonly batchIndex: number; // position within this toolCallId's tasks[] array
  readonly batchSize: number; // total slices dispatched by this single toolCallId
  readonly requestedAgent: string | null; // null = field omitted, resolves to the caller's default tier
  readonly taskPreview: string;
}

export interface SliceOutcome {
  readonly slice: RequestedSlice;
  // The AGENT id used to locate the subagent's own transcript file. Distinct
  // from the async job id: the OMP task module mints both independently
  // (`Spawned agent \`${agentId}\` (job \`${jobId}\`)`), and the transcript
  // is always keyed by agentId, never jobId. null = could not extract/pair
  // an agent id for this slice.
  readonly agentId: string | null;
  // The async job id, kept only for correlating with `hub jobs`/`wait`
  // output. NEVER use this to locate a transcript file.
  readonly jobId: string | null;
  readonly pairingNote: string | null; // set when the extracted id-pair count did not match batchSize
  readonly subagentTranscriptFound: boolean;
  readonly actualModelChanges: ReadonlyArray<{ readonly timestamp: string; readonly model: string; readonly role?: string }>;
  readonly finalModel: string | null; // last model_change in the subagent's own transcript, if any
  readonly finalThinkingLevel: string | null; // last thinking_level_change in the subagent's own transcript, if any
  readonly finalStopReason: string | null; // last assistant message's stopReason in the subagent transcript
  readonly hadToolError: boolean; // any toolResult with isError:true anywhere in the subagent transcript
  readonly jevChoice: null; // permanently unavailable — see module doc
  readonly jevConfidence: null; // permanently unavailable — see module doc
}

function readJsonl(path: string): unknown[] {
  const text = readFileSync(path, "utf8");
  const rows: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // A malformed line must not abort the whole read; skip it.
    }
  }
  return rows;
}

// Extracts every `task`/`functions.task` slice a parent session requested,
// from the model's own persisted toolCall arguments (pre-mutation).
export function extractRequestedSlices(sessionFile: string): RequestedSlice[] {
  const entries = readJsonl(sessionFile) as SessionMessageEntry[];
  const slices: RequestedSlice[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as unknown as { role: string; content?: unknown[] };
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const call = block as ToolCallBlock;
      if (call?.type !== "toolCall" || (call.name !== "task" && call.name !== "functions.task")) continue;
      const args = call.arguments ?? {};
      const tasks = Array.isArray(args.tasks) ? (args.tasks as Array<Record<string, unknown>>) : [args];
      for (const [index, item] of tasks.entries()) {
        slices.push({
          parentSessionFile: sessionFile,
          toolCallId: call.id,
          batchIndex: index,
          batchSize: tasks.length,
          requestedAgent: typeof item.agent === "string" ? item.agent : null,
          taskPreview: typeof item.task === "string" ? item.task.slice(0, 120) : "",
        });
      }
    }
  }
  return slices;
}

// Extracts every spawned `{agentId, jobId}` pair from the toolResult text for
// a given toolCallId. Both the single-spawn and multi-spawn (bullet-list)
// messages share the exact same grammar in the OMP task module:
// `` `${agentId}` (job `${jobId}`) ``. Matching that whole grammar (not just
// a bare backtick-quoted token) does double duty: it is what lets a
// single regex parse both formats, and it rejects any unrelated
// backtick-quoted bullet or mention elsewhere in the message text that
// lacks the trailing `(job ...)` — those are never counted as a spawn.
// The OMP subagent id sanitizer restricts real ids to
// `[A-Za-z0-9_-]`, so that is the charset matched here rather than a
// permissive `[^`]+` that could straddle unrelated backticks.
const SPAWN_ID_PATTERN = /`([A-Za-z0-9_-]+)` \(job `([A-Za-z0-9_-]+)`\)/gu;

export function extractSpawnedIds(sessionFile: string, toolCallId: string): Array<{ agentId: string; jobId: string }> {
  const entries = readJsonl(sessionFile) as SessionMessageEntry[];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as unknown as { role: string; toolCallId?: string; content?: unknown[] };
    if (message.role !== "toolResult" || message.toolCallId !== toolCallId) continue;
    const textBlock = (message.content ?? []).find(
      (block): block is { type: string; text: string } =>
        typeof block === "object" && block !== null && (block as { type?: string }).type === "text",
    );
    const text = textBlock?.text ?? "";
    return [...text.matchAll(SPAWN_ID_PATTERN)].map((match) => ({ agentId: match[1]!, jobId: match[2]! }));
  }
  return [];
}

// Transcripts are always keyed by AGENT id, never job id — confirmed against
// the OMP internal URL registry ("a subagent's transcript is
// `<artifactsDir>/<AgentId>.jsonl`") and the task executor's
// `subtaskSessionFile = path.join(artifactsDir, `${id}.jsonl`)`, where `id`
// is the reserved agent id, not the async job id.
function nestedTranscriptPath(sessionFile: string, agentId: string): string {
  const dir = dirname(sessionFile);
  const stem = basename(sessionFile, extname(sessionFile));
  return join(dir, stem, `${agentId}.jsonl`);
}

// Reads one spawned subagent's own transcript for real model/thinking/outcome
// facts. This is the ONLY place the post-mutation model and thinking level
// are observable at all.
export function readSubagentOutcome(sessionFile: string, agentId: string): {
  readonly transcriptFound: boolean;
  readonly modelChanges: ReadonlyArray<{ readonly timestamp: string; readonly model: string; readonly role?: string }>;
  readonly finalThinkingLevel: string | null;
  readonly finalStopReason: string | null;
  readonly hadToolError: boolean;
} {
  const path = nestedTranscriptPath(sessionFile, agentId);
  if (!existsSync(path)) {
    return { transcriptFound: false, modelChanges: [], finalThinkingLevel: null, finalStopReason: null, hadToolError: false };
  }
  const entries = readJsonl(path);
  const modelChanges: Array<{ timestamp: string; model: string; role?: string }> = [];
  let finalThinkingLevel: string | null = null;
  let finalStopReason: string | null = null;
  let hadToolError = false;
  for (const raw of entries) {
    const entry = raw as ModelChangeEntry | ThinkingLevelChangeEntry | SessionMessageEntry;
    if (entry.type === "model_change") {
      modelChanges.push({ timestamp: entry.timestamp, model: entry.model, role: entry.role });
    } else if (entry.type === "thinking_level_change") {
      finalThinkingLevel = entry.thinkingLevel;
    } else if (entry.type === "message") {
      const message = entry.message as unknown as { role: string; stopReason?: string; isError?: boolean };
      if (message.role === "assistant") finalStopReason = message.stopReason ?? null;
      if (message.role === "toolResult" && message.isError) hadToolError = true;
    }
  }
  return { transcriptFound: true, modelChanges, finalThinkingLevel, finalStopReason, hadToolError };
}

export function auditSession(sessionFile: string): SliceOutcome[] {
  const slices = extractRequestedSlices(sessionFile);
  const spawnedByToolCallId = new Map<string, Array<{ agentId: string; jobId: string }>>();
  const results: SliceOutcome[] = [];
  for (const slice of slices) {
    let spawned = spawnedByToolCallId.get(slice.toolCallId);
    if (!spawned) {
      spawned = extractSpawnedIds(sessionFile, slice.toolCallId);
      spawnedByToolCallId.set(slice.toolCallId, spawned);
    }
    // Pair by position within the batch: slice i <-> spawned[i]. This is the
    // model's own dispatch order matched against the spawn confirmation's
    // own listed order — the best available correlation without a
    // persisted slice-index -> id field in the transcript. When the
    // extracted id-pair count does not match the requested batch size, DO
    // NOT guess a pairing for the affected slices: report agentId/jobId:null
    // with an explicit pairingNote instead of silently defaulting to
    // spawned[0], which would misattribute every other slice in the batch
    // to the first job's outcome.
    const countMismatch = spawned.length !== slice.batchSize;
    const pair = countMismatch ? null : (spawned[slice.batchIndex] ?? null);
    const pairingNote = countMismatch
      ? `batch requested ${slice.batchSize} slice(s) but toolResult text listed ${spawned.length} job id(s); positional pairing is unreliable, not attempted`
      : null;
    const outcome = pair
      ? readSubagentOutcome(sessionFile, pair.agentId)
      : { transcriptFound: false, modelChanges: [], finalThinkingLevel: null, finalStopReason: null, hadToolError: false };
    results.push({
      slice,
      agentId: pair?.agentId ?? null,
      jobId: pair?.jobId ?? null,
      pairingNote,
      subagentTranscriptFound: outcome.transcriptFound,
      actualModelChanges: outcome.modelChanges,
      finalModel: outcome.modelChanges.at(-1)?.model ?? null,
      finalThinkingLevel: outcome.finalThinkingLevel,
      finalStopReason: outcome.finalStopReason,
      hadToolError: outcome.hadToolError,
      jevChoice: null,
      jevConfidence: null,
    });
  }
  return results;
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("Usage: bun run task-routing-audit.ts <path/to/session.jsonl> [...more]");
    process.exit(1);
  }
  for (const file of files) {
    for (const row of auditSession(file)) {
      console.log(JSON.stringify(row));
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// OMP scans every .ts in the extensions tree for an extension entry; this is
// a standalone CLI script, not an extension. No-op factory so it is ignored.
export default function () {}
