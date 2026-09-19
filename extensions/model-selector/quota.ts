// Generic quota / rate-limit evidence.
//
// A quota is a time-window limit (e.g. "X requests in 7 days" or
// "Y requests in 5 hours"). This module only understands a normalized shape;
// YOU provide the numbers from your own subscription's usage API, CLI, or a
// file you refresh. There are no provider names here on purpose.

export type QuotaStatus = "measured" | "unknown";
export type AccountKind = "subscription" | "shared_pool";

export interface QuotaEvidence {
  status: QuotaStatus;
  accountKind: AccountKind;
  // Window usage (subscription): 0..100 of the current window already spent.
  usedPercent?: number;
  remainingPercent?: number;
  // When the current window resets (ISO timestamp).
  resetsAt?: string;
  // Shared pool (enterprise / team plan): total concurrent slots.
  concurrencyLimit?: number;
  // Shared pool: weekly or window usage already spent, 0..100.
  windowUsedPercent?: number;
  // Per-model queue pressure, 0 = idle, 100 = at limit, >100 = queued.
  modelLoad?: number;
  note?: string;
}

// Turn a raw usage number into evidence. Missing/unparseable values become
// "unknown" rather than being treated as spare capacity.
export function measuredQuota(
  accountKind: AccountKind,
  fields: {
    usedPercent?: number;
    resetsAt?: string;
    concurrencyLimit?: number;
    windowUsedPercent?: number;
    modelLoad?: number;
  },
): QuotaEvidence {
  const ev: QuotaEvidence = { status: "measured", accountKind, ...fields };
  if (typeof ev.usedPercent === "number" && Number.isFinite(ev.usedPercent)) {
    ev.remainingPercent = Math.max(0, Math.min(100, 100 - ev.usedPercent));
  }
  return ev;
}

export function unknownQuota(accountKind: AccountKind, note: string): QuotaEvidence {
  return { status: "unknown", accountKind, note };
}

// Queue-pressure band for a shared-pool model.
export function loadBand(load: number): "stable" | "queued" | "long_wait" {
  return load < 100 ? "stable" : load <= 150 ? "queued" : "long_wait";
}
