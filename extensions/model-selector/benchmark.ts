// Generic benchmark-IQ evidence. Fetch a public coding benchmark, normalize
// it, and only expose IQ values that pass the trust rules. No model catalog
// lives here — callers pass the public benchmark name + effort for their own
// candidates.

export interface BenchmarkPoint {
  model: string; // public benchmark model name
  effort: string; // reasoning/thinking tier
  iq: number;
  samples: number;
  updatedAt: string; // ISO timestamp
}

// Below this sample count an IQ number is treated as unknown.
// Benchmark rows with n=2, for example, are noise, not evidence.
export const MIN_IQ_SAMPLES = 20;

// IQ only compares when benchmark AND effort match exactly.
export function trustIq(
  point: Pick<BenchmarkPoint, "iq" | "samples" | "effort"> | undefined,
  targetEffort: string,
): number | undefined {
  if (!point) return undefined;
  if (!Number.isFinite(point.iq)) return undefined;
  if (!Number.isInteger(point.samples) || point.samples < MIN_IQ_SAMPLES) {
    return undefined;
  }
  if (point.effort !== targetEffort) return undefined;
  return point.iq;
}

// Minimum acceptable quality for any model selected by this policy.
export const DEFAULT_IQ_FLOOR = 80;

export interface BenchmarkSourceConfig {
  // Full URL, including the benchmark query parameter.
  url: string;
  // Map the wire response into normalized points. Defaults to a
  // `{ points: [{ model, effort, iq, total, source_updated_at }] }` shape.
  parse?: (data: unknown) => BenchmarkPoint[];
  cacheTtlMs?: number;
  timeoutMs?: number;
}

function defaultParse(data: unknown): BenchmarkPoint[] {
  const points = (data as { points?: unknown[] }).points;
  if (!Array.isArray(points)) return [];
  const out: BenchmarkPoint[] = [];
  for (const p of points) {
    const r = p as Record<string, unknown>;
    const iq = Number(r.iq);
    const samples = Number(r.total ?? r.samples);
    if (
      typeof r.model === "string" &&
      typeof r.effort === "string" &&
      Number.isFinite(iq) &&
      Number.isFinite(samples) &&
      typeof (r.source_updated_at ?? r.updatedAt) === "string"
    ) {
      out.push({
        model: r.model,
        effort: r.effort,
        iq,
        samples,
        updatedAt: String(r.source_updated_at ?? r.updatedAt),
      });
    }
  }
  return out;
}

export class BenchmarkSource {
  private cache: { at: number; points: BenchmarkPoint[] } | undefined;
  constructor(private cfg: BenchmarkSourceConfig) {}

  async points(fetchImpl: typeof fetch = fetch): Promise<BenchmarkPoint[] | undefined> {
    const ttl = this.cfg.cacheTtlMs ?? 6 * 60 * 60_000;
    if (this.cache && Date.now() - this.cache.at < ttl) return this.cache.points;
    try {
      const res = await fetchImpl(this.cfg.url, {
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 3500),
      });
      if (!res.ok) return undefined;
      const data = await res.json();
      const points = (this.cfg.parse ?? defaultParse)(data);
      this.cache = { at: Date.now(), points };
      return points;
    } catch {
      return undefined;
    }
  }

  lookup(
    points: BenchmarkPoint[],
    benchmarkModel: string,
    effort: string,
  ): BenchmarkPoint | undefined {
    return points.find((p) => p.model === benchmarkModel && p.effort === effort);
  }
}
