# jev CLI

`jev` is a single-machine command-line coding agent. It runs a task against a local
working directory by driving an LLM in a loop — call tools, read results, act again —
and delegates small, well-scoped decisions (routing, model choice, acceptance gating,
permission calls) to the [Typesafe](https://typesafe.ai) Jev decision API instead of
spending the main model's context on them.

The design is ported from [pi](https://github.com/badlogic/pi-mono) (the durable,
entry-tree harness) and rebuilt as a standalone TypeScript/Bun program. It does not
depend on pi at runtime.

## Install

Requires [Bun](https://bun.sh) >= 1.1.

```bash
git clone https://github.com/luw2007/omp-jev-extensions.git
cd omp-jev-extensions
bun install
bun link        # exposes the `jev` shim, or use `bun src/cli/index.ts ...` directly
```

Set a model provider key and (optionally) a Jev key:

```bash
export OPENAI_API_KEY=...
export TYPESAFE_API_KEY=...   # optional; without it all Jev points fail open
```

## Quick start

```bash
# One-shot task, non-interactive.
jev run "create hello.ts that prints Hello World, then run it"

# Interactive REPL: multi-turn chat, /exit to leave, /compact to compact.
jev chat

# List past sessions and resume one.
jev sessions
jev resume <session-id> "now also add a goodbye function"
```

With no `TYPESAFE_API_KEY`, the agent still works: routing falls back to
single / coder / balanced, the acceptance gate passes, and the default model is used.

## CLI commands

| Command | Purpose |
| --- | --- |
| `jev run <prompt>` | Non-interactive one-shot task; exits when settled. |
| `jev chat` | Interactive loop (supports `/exit`, `/compact`, `/model`, `/permissions`, `/steer`). |
| `jev resume <id> [prompt]` | Reopen a persisted session; with a prompt runs one task, otherwise enters chat. |
| `jev sessions` | List sessions. |
| `jev session delete <id>` | Delete a session. |
| `jev tools` | List the builtin + Jev tools the agent can call. |
| `jev compact <id>` | Manually compact a session (independent compaction operation). |
| `jev audit [--type route\|stop\|foreman]` | Print the Jev decision audit log. |
| `jev bench` | Run a controlled end-to-end model benchmark. |

Common flags:

```
--model <provider/model>   override the default model
--thinking <level>         off | minimal | low | medium | high
--session <id>              use/create a specific session id
--cwd <path>                working directory (default: $PWD)
--config <path>             config file (default: ~/.jev/config.json)
--json                      NDJSON event stream on stdout (machine-readable)
--no-jev                    disable every Jev decision point (pure agent mode)
-y, --yes                   approve every permission prompt
--gate <light|heavy|off>    acceptance-gate mode
```

Exit codes from `jev run`: `0` completed, `1` general error, `2` model/tool error,
`3` permission denied.

## Configuration

`~/.jev/config.json` (see [`docs/config-example.json`](docs/config-example.json)):

```json
{
  "defaultModel": { "provider": "openai", "modelId": "gpt-4o" },
  "thinkingLevel": "medium",
  "permissions": { "default": "ask", "allow": ["echo*"], "deny": ["rm -rf *"] },
  "compaction": { "enabled": true, "reserveTokens": 16384, "keepRecentTokens": 20000 },
  "gate": "light",
  "typesafeApiKey": "env:TYPESAFE_API_KEY"
}
```

Resolution order (later wins): built-in defaults → config file → environment
(`JEV_MODEL`, `TYPESAFE_API_KEY`, `OPENAI_API_KEY`) → CLI flags.

Permissions resolve through a fixed priority chain: session `always` pre-auth →
`deny` glob → `allow` glob → `--yes` → Jev dynamic decision → `permissions.default`.
In non-interactive mode an `ask` is auto-denied (exit 3).

## Architecture

```
CLI layer        src/cli/        argv parsing, run/chat/resume/sessions/tools/compact/audit
Wiring           src/cli/wiring.ts  assembles harness + session + tools + hooks + telemetry
Harness          src/harness/    AgentHarness -> Lane -> Drive, hooks, events, system prompt
Runtime          src/runtime/    10-state drive loop, retry, compaction, effect gate, reconcile
Session          src/session/    immutable entry tree, values, JSONL persistence, mutation line
Jev decisions    src/jev/        client, route, foreman, acceptance gate, model selector, visibility
Permissions      src/permissions/ static globs + dynamic Jev provider + priority chain
Tools            src/tools/      bash, read, write, edit, file-mutation queue
Models           src/models/      provider registry, FakeProvider, OpenAI-compatible adapter
Telemetry/sec    src/telemetry/, src/security/   local exporter, audit log, data minimization
```

A run is a drive loop over a durable 10-state state machine
(`starting → checkpoint → assistant.ready → assistant.effect_pending → tools → …`).
Every external side effect commits an intent first (effect-pending), then a
settlement, so a crash can be recovered from the JSONL transcript. Context grows
until a token threshold triggers compaction (a six-section summary + retained tail);
the projection always shows the newest summary plus the tail.

Jev points are **fail-open**: a missing key, timeout, non-2xx, or malformed answer
lets the agent proceed and logs the decision with `confidence: 0`. Permission calls
are the exception — they fail closed.

## Relationship to pi

`jev` borrows pi's core mental model and rebuilds it:

- **Borrowed ideas**: immutable entry tree + parallel value/list stores, the
  intent→effect→settle sandwich, a single serial session mutation line, explicit
  trailing `Context` (no AsyncLocalStorage), immutable result records, and the
  overflow/threshold compaction shape.
- **Rebuilt**: the CLI surface, the Jev decision layer (route / foreman / gate /
  visibility / dynamic permissions), the model-selection policy, the permission
  priority chain, NDJSON event output, and the telemetry/security modules.

`jev` is a standalone Bun program; it does not import from pi.

## Development

```bash
bun run build     # tsc --noEmit
bun test          # all unit + e2e tests (FakeProvider, no network)
bun test test/e2e/  # just the S1-S12 acceptance scenarios
bunx biome check src/ test/   # lint
./scripts/verify.sh           # build + lint + test + e2e + smoke, one shot
```

All tests run against an in-memory `FakeProvider` inside a temp directory; no real
API calls or keys are needed.

## License

MIT — see [LICENSE](LICENSE).
