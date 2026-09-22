# omp-jev-extensions

Extensions for [Oh My Pi](https://github.com/oh-my-pi) (`@oh-my-pi/pi-coding-agent`) that delegate small decisions to the
[Typesafe](https://typesafe.ai) Jev decision API instead of asking the main model, plus a generic, evidence-based model selector.

- **acceptance-gate** — a `jev_acceptance_gate` tool the agent calls before declaring a task done.
  It sends the acceptance criteria and the agent's evidence summary to Jev; Jev decides whether
  the work actually meets the bar. If not, the tool tells the agent to keep going.
- **foreman** — a `foreman_assess` tool for long multi-step / parallel / dag tasks. Jev returns
  ten noul scores (completion, tests, requirements, stuck, off-track, AGENTS.md drift, needs-human,
  …); deterministic thresholds map them to CONTINUE / STEER / VERIFY / FINISH / ESCALATE.
- **route-planner** — a `jev_route` tool that picks subagent topology (direct / single / parallel /
  dag), assigns each slice to an agent class, and picks a model tier (`fast` / `smart` / `slow` /
  `task`) per slice.
- **model-selector** — generic primitives for choosing a concrete model from three kinds of
  evidence: measured throughput, a public coding benchmark, and your own quota/rate limits. No
  model names ship in the repo; you provide them in a gitignored catalog.

## Layout

```
extensions/
  acceptance-gate/
    stop-jev.ts             # registers jev_acceptance_gate, fails open if Jev is unavailable
  foreman/
    foreman.ts              # heavy 10-dimension foreman_assess gate (noul scores + action)
  route-planner/
    route-schema.ts         # RouteSlice / RoutePlan types + invariant validation
    route-jev.ts            # builds the Jev request, parses answers, validates choices
    route-agent.ts          # registers jev_route (extension entry point)
    route-audit.ts          # appends decisions to ~/.omp/agent/route-audit.jsonl
    route-test.ts           # offline unit tests (fake fetch, no network)
    route-live-dryrun.ts    # optional: one real Jev call, zero subagents spawned
  model-selector/
    perf.ts                 # read steady-state tok/s + ttft from your own sessions (agent.db)
    speed-benchmark.ts      # controlled re-measurement: runs `omp --mode json`, decode tps
    benchmark.ts            # public coding-benchmark IQ, with sample + same-effort trust gate
    quota.ts                # normalized quota / rate-limit evidence (7-day / 5-hour windows)
    select.ts               # policy: billing gate, then speed- or IQ-ranked
    catalog.example.ts      # TEMPLATE — copy to model-catalog.local.ts with your own models
    model-selector-test.ts
```

## Requirements

- [Bun](https://bun.sh) and an OMP/pi-coding-agent install that loads extensions from
  `~/.omp/agent/extensions/`.
- A Typesafe API key in `TYPESAFE_API_KEY`. The extensions call
  `POST https://api.typesafe.ai/v1/systemone` with model `jev-latest`.

## Install

Keep the repository intact outside OMP's extension discovery directory. Symlink
**only extension entry points** into `~/.omp/agent/extensions/`:

```bash
git clone https://github.com/luw2007/omp-jev-extensions.git ~/omp-extensions/omp-jev-extensions
mkdir -p ~/.omp/agent/extensions
ln -s ~/omp-extensions/omp-jev-extensions/extensions/route-planner/route-agent.ts \
  ~/.omp/agent/extensions/route-agent.ts
ln -s ~/omp-extensions/omp-jev-extensions/extensions/acceptance-gate/stop-jev.ts \
  ~/.omp/agent/extensions/stop-jev.ts
export TYPESAFE_API_KEY=...
```

Do **not** copy `route-schema.ts`, `route-jev.ts`, `route-audit.ts`, tests, or dry
runs into `~/.omp/agent/extensions/`. OMP treats every top-level `.ts` file in
that directory as an extension entry and warns when a helper module does not
export a factory function. Those files must remain next to the entry point in
the cloned repository so relative imports work.

Restart OMP after installing or updating the symlinks.

Then add a line to your project `AGENTS.md` so the agent actually uses the gate:

> Before telling the user the task is done, call `jev_acceptance_gate` with the original target,
> the acceptance criteria, and what you actually verified. If it returns `accepted=false`, keep
> working.

## model-selector: setup required

The math is public; *which* models and subscriptions you use is personal and deliberately
absent from the repo.

1. Copy `catalog.example.ts` to `model-catalog.local.ts` (gitignored) and list your concrete
   `provider/model` + thinking combos. Each row's `key` must match how OMP records it in
   `model_perf` (`provider/model`). Set `billing` and `quotaKey`, and optionally the public
   benchmark name + effort for IQ.
2. Write a small quota adapter that reads your own subscription usage (provider usage API, CLI,
   or a refreshed file) and returns the shape from `quota.ts`: `usedPercent` + `resetsAt` for
   window limits (e.g. 7-day / 5-hour), or `concurrencyLimit` / `windowUsedPercent` / `modelLoad`
   for a shared team pool.
3. Set `TYPESAFE_API_KEY`.

### Evidence and policy

`select.ts` ranks your rows (the same evidence can also be sent to Jev as one choice question):

- **Billing first.** A subscription with a depleted window, or a shared pool with
  `load >= 100`, is dropped before any ranking.
- **Speed** from `perf.ts` (historical sessions) or `speed-benchmark.ts` (controlled
  re-measurement). The benchmark runner calls `omp -p --mode json --no-session`, reads
  `ttft` / `duration` (milliseconds) off the final assistant `message_end`, excludes TTFT from
  the decode tps, and rejects runs under 300 output tokens — burst output is not steady-state
  throughput. It also verifies on the wire that no reasoning happened: a missing rendered
  thinking block is not proof, so it checks content blocks and billed `usage.reasoningTokens`.
- **IQ** from `benchmark.ts`. A point is trusted only when it has at least 20 samples AND the
  benchmark effort matches the requested thinking tier. Cross-family IQ numbers (e.g. one
  vendor's benchmark vs another's) are never silently compared; without an explicit,
  user-supplied equivalence the IQ is unknown.

Role policy:

- `smol` / `fast` / `task` — speed-ranked, but any candidate below the IQ floor is eliminated;
  a slow, ample-quota model can be attached as a backstop.
- `smart` / `advisor` / `plan` — IQ-ranked; speed does not participate in ordering.

Measurement discipline behind the harness: compare models on the same prompt, same thinking
tier, multiple trials; retract any "faster / stronger / cheaper" claim that fails its evidence
check and re-measure instead of defending it.

## Design notes

- **Fail-open, never fail-catch.** If Jev is missing, times out, returns a non-2xx, or a malformed
  answer, the acceptance gate allows the action and logs it. A flaky decision service must never
  trap the agent. Fail-open paths carry `confidence: 0` so a downstream consumer can tell them
  apart from a real confident answer.
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
bun run extensions/model-selector/model-selector-test.ts
```

One real Jev call (needs `TYPESAFE_API_KEY`), spawns no subagents:

```bash
bun run extensions/route-planner/route-live-dryrun.ts
```

## Status / known gap

`route-planner` writes the chosen tier onto `RouteSlice.model`. Wiring that tier into the
model-selector candidate filter at subagent spawn time is left to your own OMP setup — wire it
in once you trust the choices.

## License

MIT — see [LICENSE](LICENSE).
