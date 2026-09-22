import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RoutePlan } from "./route-schema.js";

const AUDIT_LOG_PATH = join(homedir(), ".omp", "agent", "route-audit.jsonl");

export interface RouteAuditRecord {
  timestamp: string;
  task: string;
  plan?: RoutePlan;
  error?: string;
  status: "success" | "failed";
}

export async function logRouteAudit(record: Omit<RouteAuditRecord, "timestamp">): Promise<void> {
  const entry: RouteAuditRecord = {
    timestamp: new Date().toISOString(),
    ...record,
  };
  try {
    await appendFile(AUDIT_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Non-blocking audit failure
  }
}

// OMP scans every .ts in the extensions tree; this module is imported by
// route-agent.ts and does not register tools itself. No-op factory.
export default function () {}
