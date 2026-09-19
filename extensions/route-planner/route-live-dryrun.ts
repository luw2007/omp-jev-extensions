import { askJevRoutePlan, type RoutePromptContext } from "./route-jev.js";
import { deriveCandidateSlices } from "./route-agent.js";

async function runLiveDryRun() {
  console.log("Running Live Jev Dry-Run (zero task spawn)...");

  const prompt = `Perform system check:
1. Inspect git status and commit history
2. Check memory usage and CPU load`;

  const candidates = deriveCandidateSlices(prompt);
  const ctx: RoutePromptContext = {
    task: prompt,
    candidates,
  };

  try {
    const plan = await askJevRoutePlan(ctx);
    console.log("Jev returned valid plan:");
    console.log(JSON.stringify(plan, null, 2));
    if (!plan.mode || !plan.slices) {
      throw new Error("Incomplete plan returned");
    }
    console.log("✓ Live Jev dry-run verified successfully!");
  } catch (err) {
    console.error("Live dry run failed:", err);
    process.exit(1);
  }
}

runLiveDryRun();
