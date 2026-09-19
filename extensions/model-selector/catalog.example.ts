// EXAMPLE. Copy this file to `model-catalog.local.ts` (gitignored) and fill
// in YOUR own providers/models. The public repo deliberately ships no real
// model list — that is private to your setup.
//
// Each entry is one concrete model+thinking combo you can actually call.
// `key` must match how OMP records it in model_perf, i.e. `${provider}/${model}`.
// `quotaKey` groups entries that share a subscription / shared pool, so the
// selector can attach the right quota evidence to each.

export interface CatalogEntry {
  key: string; // provider/model, must match model_perf.model_key
  agentClass: "fast" | "smart" | "review"; // which role this model plays
  provider: string;
  model: string;
  thinking: string;
  quotaKey: string; // your own label, e.g. "my-claude-sub", "my-openai-sub", "team-pool"
  // Optional benchmark lookup (leave undefined if you don't use one):
  benchmarkModel?: string;
  benchmarkEffort?: string;
}

const catalog: CatalogEntry[] = [
  // Example row — replace with your own:
  // {
  //   key: "myprovider/my-fast-model",
  //   agentClass: "fast",
  //   provider: "myprovider",
  //   model: "my-fast-model",
  //   thinking: "medium",
  //   quotaKey: "my-sub",
  // },
];

export default catalog;
