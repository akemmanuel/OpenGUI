import type { HarnessInventory } from "../../../src/types/electron.d.ts";

/** Per-harness readiness row for `og.diagnose()` (ADR 0007). */
export interface HarnessDiagnoseEntry {
  harnessId: string;
  label: string;
  cliOnPath: boolean;
  ready: boolean;
  hint?: string;
}

export interface OpenGUIDiagnoseResult {
  /** True when at least one harness reports `ready` (CLI executable). */
  ok: boolean;
  harnesses: HarnessDiagnoseEntry[];
}

/** Map full inventories to a small diagnostic snapshot (CONTEXT **Harness Inventory**). */
export function diagnoseFromInventories(inventories: HarnessInventory[]): OpenGUIDiagnoseResult {
  const harnesses = inventories.map((row) => ({
    harnessId: row.harnessId,
    label: row.displayName,
    cliOnPath: Boolean(row.installed && row.diagnostics?.cli?.resolvedPath),
    ready: row.status === "ready",
    hint: row.message?.trim() || undefined,
  }));
  return { ok: harnesses.some((entry) => entry.ready), harnesses };
}
