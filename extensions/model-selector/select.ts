// Deterministic model-selection policy. Evidence shape only — no provider or
// model names. Build candidates from YOUR catalog, local perf / benchmark
// runs, and quota adapter, then call selectModel.
//
// Order of preference: billing constraints first, then the role-specific
// ranking (speed for high-frequency roles, IQ for load-bearing roles).

import { DEFAULT_IQ_FLOOR, trustIq } from "./benchmark.js";

export type BillingKind = "subscription" | "shared_pool";
export type RoleKind =
  | "smol"
  | "fast"
  | "task"
  | "smart"
  | "advisor"
  | "plan";

export interface ModelCandidate {
  id: string;
  role: string; // agent class
  billing: BillingKind;
  // Measured steady-state decode speed (see speed-benchmark.ts). Unknown
  // speed is undefined, never 0.
  tokPerSec?: number;
  // Benchmark IQ, only attached when same benchmark + same effort and the
  // sample count passes the trust threshold.
  iq?: number;
  targetEffort: string;
  // Subscription: percent of the window remaining (0..100).
  quotaRemaining?: number;
  // Shared pool: queue pressure, <100 stable, >=100 saturated.
  load?: number;
  // The benchmark point if available, used to re-validate effort/samples.
  benchmarkPoint?: { iq: number; samples: number; effort: string };
}

export interface SelectOptions {
  role: RoleKind;
  candidates: ModelCandidate[];
  // Below this quota the subscription is considered depleted for this role.
  subscriptionFloorPercent?: number;
  // Minimum IQ for high-frequency roles; slower candidates below it are
  // eliminated regardless of speed.
  iqFloor?: number;
  // A cheap, ample-quota backstop for high-frequency roles. It can be slow;
  // it exists so routing never has zero fallback.
  backstopId?: string;
}

export interface Selection {
  primary?: ModelCandidate;
  fallback: ModelCandidate[];
  eliminated: { id: string; reason: string }[];
}

const HIGH_FREQUENCY: RoleKind[] = ["smol", "fast", "task"];
const LOAD_BEARING: RoleKind[] = ["smart", "advisor", "plan"];

function validSubscription(c: ModelCandidate, floor: number): boolean {
  return c.billing === "subscription" && (c.quotaRemaining ?? 0) > floor;
}

function validSharedPool(c: ModelCandidate): boolean {
  return c.billing === "shared_pool" && (c.load ?? Infinity) < 100;
}

export function selectModel(opts: SelectOptions): Selection {
  const floor = opts.subscriptionFloorPercent ?? 5;
  const iqFloor = opts.iqFloor ?? DEFAULT_IQ_FLOOR;
  const eliminated: Selection["eliminated"] = [];

  const drop = (c: ModelCandidate, reason: string) =>
    eliminated.push({ id: c.id, reason });

  const withTrustedIq = (c: ModelCandidate): ModelCandidate => {
    if (c.benchmarkPoint) {
      const trusted = trustIq(c.benchmarkPoint, c.targetEffort);
      return trusted === undefined ? { ...c, iq: undefined } : { ...c, iq: trusted };
    }
    return c;
  };

  const eligible = opts.candidates.map(withTrustedIq).filter((c) => {
    if (!validSubscription(c, floor) && !validSharedPool(c)) {
      drop(c, "billing unavailable: depleted quota or saturated pool");
      return false;
    }
    return true;
  });

  let ranked: ModelCandidate[];
  if (HIGH_FREQUENCY.includes(opts.role)) {
    // Speed first; IQ is only a floor. Unknown speed sorts after measured
    // speed (unknown is not slow, but measured evidence wins).
    ranked = eligible
      .filter((c) => {
        if (c.iq !== undefined && c.iq < iqFloor) {
          drop(c, `iq ${c.iq} below floor ${iqFloor}`);
          return false;
        }
        return true;
      })
      .sort((a, b) => (b.tokPerSec ?? -1) - (a.tokPerSec ?? -1));
  } else if (LOAD_BEARING.includes(opts.role)) {
    // IQ first; speed does not participate in ordering. Untrusted IQ sorts
    // below any trusted value but is not deleted (it may be the only option).
    ranked = [...eligible].sort((a, b) => (b.iq ?? -1) - (a.iq ?? -1));
  } else {
    ranked = eligible;
  }

  const [primary, ...rest] = ranked;
  const fallback = [...rest];
  if (opts.backstopId) {
    const backstop = opts.candidates.find((c) => c.id === opts.backstopId);
    if (backstop && backstop.id !== primary?.id && !fallback.some((c) => c.id === backstop.id)) {
      fallback.push(withTrustedIq(backstop));
    }
  }
  return { primary, fallback, eliminated };
}
