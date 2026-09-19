# omp-jev-extensions

Two self-contained extensions for [Oh My Pi](https://github.com/oh-my-pi) (`@oh-my-pi/pi-coding-agent`) that delegate small decisions to the
[Typesafe](https://typesafe.ai) Jev decision API instead of asking the main model.

- **acceptance-gate** — a `jev_acceptance_gate` tool the agent calls before declaring a task done.
  It sends the acceptance criteria and the agent's evidence summary to Jev; Jev decides whether
  the work actually meets the bar. If not, the tool tells the agent to keep going.
- **route-planner** — a `jev_route` tool that picks subagent topology (direct / single / parallel /
  dag), assigns each slice to an agent class, and picks a model tier (`fast` / `smart` / `slow` /
  `task`) per slice.

## Layout

```
extensions/
  acceptance-gate/
    stop-jev.ts        # registers jev_acceptance_gate, fails open if Jev is unavailable
  route-planner/
    route-schema.ts    # RouteSlice / RoutePlan types + invariant validation
    route-jev.ts       # builds the Jev request, parses answers, validates choices
    route-agent.ts     # registers jev_route
    route-audit.ts     # appends decisions to ~/.omp/agent/route-audit.jsonl
    route-test.ts      # offline unit tests (fake fetch, no network)
    route-live-dryrun.ts  # optional: one real Jev call, zero subagents spawned
```

## Requirements

- [Bun](https://bun.sh) and an OMP/pi-coding-agent install that loads extensions from
  `~/.omp/agent/extensions/`.
- A Typesafe API key in `TYPESAFE_API_KEY`. The extensions call
  `POST https://api.typesafe.ai/v1/systemone` with model `jev-latest`.

## Install

Copy the files into your OMP extensions directory and restart OMP:

```bash
mkdir -p ~/.omp/agent/extensions/acceptance-gate ~/.omp/agent/extensions/route-planner
cp extensions/acceptance-gate/*.ts  ~/.omp/agent/extensions/acceptance-gate/
cp extensions/route-planner/*.ts    ~/.omp/agent/extensions/route-planner/
export TYPESAFE_API_KEY=...
```

Then add a line to your project `AGENTS.md` so the agent actually uses the gate:

> Before telling the user the task is done, call `jev_acceptance_gate` with the original target,
> the acceptance criteria, and what you actually verified. If it returns `accepted=false`, keep
> working.

## Design notes

- **Fail-open, never fail-catch.** If Jev is missing, times out, returns a non-2xx, or a malformed
  answer, both extensions allow the action and log it. A flaky decision service must never trap
  the agent. Fail-open paths carry `confidence: 0` so a downstream consumer can tell them apart
  from a real confident answer.
- **Choice questions, not boolean.** The SystemOne API only accepts `type: "choice"` questions;
  the acceptance gate therefore uses criteria `{ accepted, rejected }` and parses the choice back.
  The parser also tolerates a plain boolean `answer` field.
- **Choices are validated.** Any `model_<id>` or `agent_<id>` answer outside the allowed set is
  discarded and replaced by a per-agent default, instead of being type-asserted into a lie.
- **Audit logs are append-only JSONL.** `route-audit.jsonl` records routing decisions;
  `stop-audit.jsonl` records gate verdicts.

## Tests

Offline, no network:

```bash
bun run extensions/route-planner/route-test.ts
```

One real Jev call (needs `TYPESAFE_API_KEY`), spawns no subagents:

```bash
bun run extensions/route-planner/route-live-dryrun.ts
```

## Status / known gap

`route-planner` writes the chosen tier onto `RouteSlice.model`, but the consuming side that maps
that tier onto a concrete provider/model string is left to your own OMP config. Wire it in once
you trust Jev's choices.

## License

MIT — see [LICENSE](LICENSE).
