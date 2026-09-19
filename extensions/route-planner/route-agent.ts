import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type KnownAgent, KNOWN_AGENTS, type RoutePlan, validateRoutePlanInvariants } from "./route-schema.js";
import { askJevRoutePlan, type CandidateSliceInput } from "./route-jev.js";
import { logRouteAudit } from "./route-audit.js";

export function deriveCandidateSlices(task: string): CandidateSliceInput[] {
  const parts = task
    .split(/\n\s*[-*]\s+|\n\s*\d+\.\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (parts.length > 1) {
    return parts.map((part, idx) => ({
      id: `slice_${idx + 1}`,
      target: `Scope for sub-task ${idx + 1}`,
      change: part,
      acceptance: `Observable success criteria for: ${part}`,
      isReadonly: /\b(read|inspect|check|audit|search|investigate)\b/i.test(part),
    }));
  }

  return [
    {
      id: "slice_1",
      target: "Project files relevant to task",
      change: task,
      acceptance: "All task requirements satisfied and verified",
      isReadonly: /\b(read|inspect|check|audit|search|investigate)\b/i.test(task),
    },
  ];
}

export default function routeAgentExtension(pi: ExtensionAPI) {
  const z = pi.zod;

  pi.registerTool({
    name: "jev_route",
    label: "Jev Route Agent Planner",
    description: "Derives and arbitrates subagent delegation topology (direct, single, parallel, dag) using Jev.",
    parameters: z.object({
      task: z.string().describe("User prompt or high-level task instructions"),
      pinnedAgent: z.string().optional().describe("Optional explicit user-pinned agent class override"),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const candidates = deriveCandidateSlices(params.task);
        let pinned: KnownAgent | undefined;
        if (params.pinnedAgent && (KNOWN_AGENTS as readonly string[]).includes(params.pinnedAgent)) {
          pinned = params.pinnedAgent as KnownAgent;
        }
        const plan = await askJevRoutePlan({
          task: params.task,
          candidates,
          pinnedAgent: pinned,
        });

        await logRouteAudit({ task: params.task, plan, status: "success" });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(plan, null, 2),
            },
          ],
          details: { plan },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await logRouteAudit({ task: params.task, error: message, status: "failed" });
        return {
          content: [
            {
              type: "text",
              text: `Route planning failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  });
}
