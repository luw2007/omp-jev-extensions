// Generic local-throughput reader. Works for any OMP install: it reads the
// `model_perf` table that OMP itself maintains under ~/.omp/agent/agent.db.
// Nothing here knows your providers or models — it just maps
// `${provider}/${model}` -> measured tok/s and first-token latency.
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

export interface LocalSpeed {
  tokPerSec: number;
  ttftSec: number;
  samples: number;
}

// Rows with too few samples are noise; treat them as unknown instead.
export const MIN_HISTORY_SAMPLES = 20;

const perfDbPath = join(homedir(), ".omp", "agent", "agent.db");
const perfTtlMs = 5 * 60_000;
let cache: { at: number; map: Map<string, LocalSpeed> } | undefined;

export async function localSpeeds(): Promise<Map<string, LocalSpeed> | undefined> {
  if (cache && Date.now() - cache.at < perfTtlMs) return cache.map;
  try {
    const db = new Database(perfDbPath, { readonly: true });
    const rows = db
      .query(
        "SELECT model_key, samples, output_tokens, gen_ms, ttft_ms, ttft_samples FROM model_perf",
      )
      .all() as Array<{
      model_key: string;
      samples: number;
      output_tokens: number;
      gen_ms: number;
      ttft_ms: number;
      ttft_samples: number;
    }>;
    db.close();
    const map = new Map<string, LocalSpeed>();
    for (const r of rows) {
      if (r.samples < MIN_HISTORY_SAMPLES || r.gen_ms <= 0 || r.output_tokens <= 0) continue;
      map.set(r.model_key, {
        tokPerSec: r.output_tokens / (r.gen_ms / 1000),
        ttftSec: r.ttft_samples > 0 ? r.ttft_ms / r.ttft_samples / 1000 : 0,
        samples: r.samples,
      });
    }
    cache = { at: Date.now(), map };
    return map;
  } catch {
    return undefined;
  }
}
