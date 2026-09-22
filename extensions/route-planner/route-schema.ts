// Example agent catalog. These are role names, not provider/model strings.
// Replace with the agent classes you actually registered in your OMP config.
export const KNOWN_AGENTS = [
  "fast",
  "smart",
  "scout",
  "reviewer",
  "deep-worker",
] as const;
export type KnownAgent = typeof KNOWN_AGENTS[number];

export const TASK_CLASSES = [
  "mechanical",
  "research",
  "routine",
  "smart",
  "review",
] as const;
export type TaskClass = typeof TASK_CLASSES[number];

// Model tiers the Jev router may pick per slice. Mirrors the modelRoles
// in ~/.omp/agent/config.yml; kept as a small choice set so Jev decides
// tier, not exact provider strings.
export const MODEL_ROLES = [
  "fast",
  "smart",
  "slow",
  "task",
] as const;
export type ModelRole = typeof MODEL_ROLES[number];

export const ROUTE_MODES = ["direct", "single", "parallel", "dag"] as const;
export type RouteMode = typeof ROUTE_MODES[number];

export interface RouteSlice {
  id: string;
  agent: KnownAgent;
  taskClass: TaskClass;
  dependsOn: string[];
  target: string;
  change: string;
  acceptance: string;
  tools?: string[];
  model?: ModelRole;
}

export interface RoutePlan {
  version: 1;
  mode: RouteMode;
  rationale: string;
  slices: RouteSlice[];
  // Light = single boolean acceptance gate (jev_acceptance_gate).
  // Heavy = 10-dimension foreman assessment (foreman_assess).
  recommendedGate?: "light" | "heavy";
}

export function validateRoutePlanInvariants(plan: RoutePlan): void {
  if (plan.version !== 1) {
    throw new Error(`Unsupported plan version: ${plan.version}`);
  }
  if (!ROUTE_MODES.includes(plan.mode)) {
    throw new Error(`Invalid route mode: ${plan.mode}`);
  }

  const sliceIds = new Set<string>();
  for (const s of plan.slices) {
    if (sliceIds.has(s.id)) {
      throw new Error(`Duplicate slice id: ${s.id}`);
    }
    sliceIds.add(s.id);
  }

  // 1. Check dependency references
  for (const s of plan.slices) {
    for (const dep of s.dependsOn) {
      if (!sliceIds.has(dep)) {
        throw new Error(`Slice ${s.id} depends on unknown slice: ${dep}`);
      }
      if (dep === s.id) {
        throw new Error(`Slice ${s.id} cannot depend on itself`);
      }
    }
  }

  // 2. Check DAG acyclicity
  const visited = new Set<string>();
  const recStack = new Set<string>();

  function checkCycle(nodeId: string): void {
    visited.add(nodeId);
    recStack.add(nodeId);
    const slice = plan.slices.find((s) => s.id === nodeId)!;
    for (const dep of slice.dependsOn) {
      if (!visited.has(dep)) {
        checkCycle(dep);
      } else if (recStack.has(dep)) {
        throw new Error(`Cyclic dependency detected involving slice: ${nodeId} -> ${dep}`);
      }
    }
    recStack.delete(nodeId);
  }

  for (const s of plan.slices) {
    if (!visited.has(s.id)) {
      checkCycle(s.id);
    }
  }

  // 3. Mode invariants
  if (plan.mode === "direct" && plan.slices.length > 0) {
    throw new Error("Direct mode must not contain any subagent slices");
  }
  if (plan.mode === "single" && plan.slices.length !== 1) {
    throw new Error(`Single mode requires exactly 1 slice, got ${plan.slices.length}`);
  }
  if (plan.mode === "parallel") {
    if (plan.slices.length < 2) {
      throw new Error(`Parallel mode requires at least 2 slices, got ${plan.slices.length}`);
    }
    for (const s of plan.slices) {
      if (s.dependsOn.length > 0) {
        throw new Error(`Parallel mode slices must not have dependencies: slice ${s.id}`);
      }
    }
  }
  if (plan.mode === "dag") {
    if (plan.slices.length < 2) {
      throw new Error(`DAG mode requires at least 2 slices, got ${plan.slices.length}`);
    }
    const hasAnyDep = plan.slices.some((s) => s.dependsOn.length > 0);
    if (!hasAnyDep) {
      throw new Error("DAG mode specified but no dependencies exist across slices; should be parallel mode");
    }
  }

  // 4. Role invariants
  for (const s of plan.slices) {
    if (s.taskClass === "research" && s.agent !== "scout") {
      throw new Error(`Research taskClass must be assigned to scout, got: ${s.agent}`);
    }
    if (s.agent === "scout" && s.taskClass !== "research") {
      throw new Error(`Scout agent can only be assigned to research taskClass, got: ${s.taskClass}`);
    }
    if (s.model && !(MODEL_ROLES as readonly string[]).includes(s.model)) {
      throw new Error(`Invalid model role for slice ${s.id}: ${String(s.model)}`);
    }
  }
}

// OMP scans every .ts in the extensions tree; this module is imported by
// route-agent.ts and does not register tools itself. No-op factory.
export default function () {}
