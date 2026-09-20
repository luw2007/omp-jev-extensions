// Controlled throughput measurement. Sessions in model_perf reflect real
// mixed traffic; this harness measures steady-state decode speed on one
// prompt so models can be compared fairly.
//
// It runs `omp -p --mode json "<prompt>"` and parses the NDJSON event
// stream. The authoritative timing lives on the final assistant
// `message_end` event: message.ttft and message.duration, in MILLISECONDS.
// TTFT is excluded from the throughput number: time-to-first-token is
// queue + prompt processing, not decode speed.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Default runner. Uses spawn with stdin ignored so OMP print mode consumes the
// positional prompt instead of waiting on a piped stdin that never closes.
// (Bun's execFile does not reliably forward stdio:"ignore", which left OMP
// stuck in phase readPipedInput.)
function runOmp(
  bin: string,
  args: string[],
  opts: { timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`${bin} exited code=${code} signal=${signal}\n${err}`));
    });
  });
}

export interface SpeedTrial {
  ttftSec: number;
  tokPerSec: number;
  outputTokens: number;
}

// Burst output is not steady state. A response shorter than this gives a
// decode speed dominated by startup noise and must be re-measured on a
// longer prompt.
export const MIN_OUTPUT_TOKENS = 300;

export class NeedLongerPrompt extends Error {
  constructor(public maxOutputTokens: number) {
    super(
      `Largest response was ${maxOutputTokens} output tokens (< ${MIN_OUTPUT_TOKENS}); ` +
        "burst != steady-state. Use a longer prompt and re-measure.",
    );
    this.name = "NeedLongerPrompt";
  }
}

interface UsageShape {
  output?: number;
  reasoningTokens?: number;
}

interface AssistantWireMessage {
  role: "assistant";
  content?: unknown;
  usage?: UsageShape;
  duration?: number; // ms
  ttft?: number; // ms
}

interface JsonEvent {
  type?: string;
  message?: AssistantWireMessage;
}

// Parse the OMP JSON event stream and return the FIRST completed assistant
// message that carries timing and non-zero output. Subsequent injected turns
// (plan/continue meta-turns from host features) are not the benchmarked
// answer.
export function parseAssistantTiming(stdout: string): {
  msg: AssistantWireMessage;
  raw: string;
} {
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let ev: JsonEvent;
    try {
      ev = JSON.parse(trimmed) as JsonEvent;
    } catch {
      continue;
    }
    const m = ev.message;
    if (
      ev.type === "message_end" &&
      m?.role === "assistant" &&
      typeof m.duration === "number" &&
      typeof m.ttft === "number" &&
      typeof m.usage?.output === "number" &&
      m.usage.output > 0
    ) {
      return { msg: m, raw: trimmed };
    }
  }
  throw new Error("JSON stream had no completed assistant message with ttft/duration/usage.output");
}

// True only when the WIRE payload proves no reasoning happened: no thinking
// content block and no reasoning tokens billed. A missing rendered thinking
// block is not evidence.
export function wireHasNoReasoning(msg: AssistantWireMessage): boolean {
  if (typeof msg.usage?.reasoningTokens === "number" && msg.usage.reasoningTokens > 0) {
    return false;
  }
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      const t = (block as { type?: string } | null)?.type;
      if (t === "thinking" || t === "reasoning") return false;
    }
  }
  return true;
}

export interface MeasureOptions {
  model: string; // full provider/model
  prompt: string;
  thinking?: string; // off | low | medium | high | xhigh | max
  trials?: number;
  timeoutMs?: number;
  ompBin?: string;
  // Extra argv (e.g. "--no-extensions"). The harness already passes
  // -p --mode json --no-session.
  extraArgs?: string[];
  // Override the wire-level no-thinking assertion. By default the payload is
  // checked for thinking blocks and billed reasoning tokens.
  assertNoReasoning?: (msg: AssistantWireMessage, raw: string) => boolean;
  execImpl?: typeof exec;
}

export async function measureSpeed(opts: MeasureOptions): Promise<SpeedTrial[]> {
  const trials = opts.trials ?? 3;
  const run = opts.execImpl ?? exec;
  const results: SpeedTrial[] = [];

  for (let i = 0; i < trials; i++) {
    const args = [
      "-p",
      "--mode",
      "json",
      "--no-session",
      ...(opts.extraArgs ?? []),
      "--model",
      `${opts.model}:${opts.thinking ?? "off"}`,
      opts.prompt,
    ];
    // Tests inject an execFile-shaped fake; real runs use the spawn runner.
    const { stdout } = opts.execImpl
      ? await run(opts.ompBin ?? "omp", args, {
          timeout: opts.timeoutMs ?? 180_000,
          maxBuffer: 32 * 1024 * 1024,
        })
      : await runOmp(opts.ompBin ?? "omp", args, { timeoutMs: opts.timeoutMs ?? 180_000 });

    const { msg, raw } = parseAssistantTiming(stdout);
    const assertNoReasoning = opts.assertNoReasoning ?? wireHasNoReasoning;
    if (!assertNoReasoning(msg, raw)) {
      throw new Error(
        "Wire payload contains reasoning (thinking block or usage.reasoningTokens > 0) despite the requested thinking tier; bare-ID is not proof of no-thinking.",
      );
    }

    const ttftMs = msg.ttft!;
    const durationMs = msg.duration!;
    const outputTokens = msg.usage!.output!;
    const genTimeSec = (durationMs - ttftMs) / 1000; // decode only
    if (genTimeSec <= 0) {
      throw new Error(`Non-positive decode window (durationMs=${durationMs}, ttftMs=${ttftMs})`);
    }
    results.push({
      ttftSec: ttftMs / 1000,
      tokPerSec: outputTokens / genTimeSec,
      outputTokens,
    });
  }

  const maxOutput = Math.max(...results.map((r) => r.outputTokens));
  if (maxOutput < MIN_OUTPUT_TOKENS) {
    throw new NeedLongerPrompt(maxOutput);
  }
  return results;
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function summarizeTrials(trials: SpeedTrial[]): {
  medianTokPerSec: number;
  medianTtftSec: number;
} {
  return {
    medianTokPerSec: median(trials.map((t) => t.tokPerSec)),
    medianTtftSec: median(trials.map((t) => t.ttftSec)),
  };
}
