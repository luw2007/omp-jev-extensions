// EXAMPLE. Copy this file to `model-catalog.local.ts` (gitignored) and fill
// in YOUR own providers/models. The public repo deliberately ships no real
// model list — that is private to your setup.
//
// Each entry is one concrete model+thinking combo you can actually call.
// `key` must match how OMP records it in model_perf, i.e. `${provider}/${model}`.
// `quotaKey` groups entries that share a subscription / shared pool, so your
// quota adapter can attach the right usage evidence to each.

export interface CatalogEntry {
  id: string; // stable id used as the Jev choice key
  key: string; // provider/model, must match model_perf.model_key
  role: "judge" | "smol" | "fast" | "task" | "smart" | "advisor" | "plan";
  provider: string;
  model: string;
  thinking: string; // off | low | medium | high | xhigh | max
  billing: "subscription" | "shared_pool";
  quotaKey: string; // your own label, e.g. "my-claude-sub", "team-pool"
  // Map to the public benchmark model + matching effort for IQ. Without a
  // trusted same-effort point (at least 20 samples), this row is ineligible.
  benchmarkModel?: string;
  benchmarkEffort?: string;
}

const catalog: CatalogEntry[] = [
  // Example row — replace with your own:
  // {
  //   id: "my-fast",
  //   key: "myprovider/my-fast-model",
  //   role: "fast",
  //   provider: "myprovider",
  //   model: "my-fast-model",
  //   thinking: "high",
  //   billing: "subscription",
  //   quotaKey: "my-sub",
  //   benchmarkModel: "my-fast-model",
  //   benchmarkEffort: "high",
  // },
];

export default catalog;
