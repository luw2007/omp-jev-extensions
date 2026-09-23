// Deterministic model-selection policy. Evidence shape only — no provider or
// model names. Build candidates from YOUR catalog, local perf / benchmark
// runs, and quota adapter, then call selectModel.
//
// Order of preference: billing and trusted IQ constraints first, then the
// role-specific ranking (speed for high-frequency roles, IQ for load-bearing roles).

import { DEFAULT_IQ_FLOOR, trustIq } from "./benchmark.js";

export type BillingKind = "subscription" | "shared_pool";
export type RoleKind =
  | "smol"
  | "fast"
  | "task"
  | "smart"
  | "judge"
  | "advisor"
  | "plan";

export interface ModelCandidate {
  id: string;
  role: string; // agent class
  billing: BillingKind;
  // Measured steady-state decode speed (see speed-benchmark.ts). Unknown
  // speed is undefined, never 0.
  tokPerSec?: number;
  // Computed from benchmarkPoint by selectModel; any caller-supplied value is ignored.
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
}

export interface Selection {
  primary?: ModelCandidate;
  fallback: ModelCandidate[];
  eliminated: { id: string; reason: string }[];
}

const HIGH_FREQUENCY: RoleKind[] = ["smol", "fast", "task", "judge"];
const LOAD_BEARING: RoleKind[] = ["smart", "advisor", "plan"];

function validSubscription(c: ModelCandidate, floor: number): boolean {
  return c.billing === "subscription" && (c.quotaRemaining ?? 0) > floor;
}

function validSharedPool(c: ModelCandidate): boolean {
  return c.billing === "shared_pool" && (c.load ?? Infinity) < 100;
}

export function selectModel(opts: SelectOptions): Selection {
  const floor = opts.subscriptionFloorPercent ?? 5;
  const iqFloor = DEFAULT_IQ_FLOOR;
  const eliminated: Selection["eliminated"] = [];

  const drop = (c: ModelCandidate, reason: string) =>
    eliminated.push({ id: c.id, reason });

  const withTrustedIq = (c: ModelCandidate): ModelCandidate => ({
    ...c,
    iq: trustIq(c.benchmarkPoint, c.targetEffort),
  });

  const eligible = opts.candidates.map(withTrustedIq).filter((c) => {
    if (!validSubscription(c, floor) && !validSharedPool(c)) {
      drop(c, "billing unavailable: depleted quota or saturated pool");
      return false;
    }
    if (c.iq === undefined || c.iq < iqFloor) {
      drop(c, c.iq === undefined ? "trusted IQ unavailable" : `iq ${c.iq} below floor ${iqFloor}`);
      return false;
    }
    return true;
  });

  let ranked: ModelCandidate[];
  if (HIGH_FREQUENCY.includes(opts.role)) {
    // Speed first among qualified models. Unknown speed sorts after measured speed.
    ranked = eligible.sort((a, b) => (b.tokPerSec ?? -1) - (a.tokPerSec ?? -1));
  } else if (LOAD_BEARING.includes(opts.role)) {
    ranked = eligible.sort((a, b) => (b.iq ?? -1) - (a.iq ?? -1));
  } else {
    ranked = eligible;
  }

  const [primary, ...fallback] = ranked;
  return { primary, fallback, eliminated };
}
