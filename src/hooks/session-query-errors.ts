import type { HarnessId } from "@/agents";
import type { SessionQueryResult } from "@/protocol/client";
import { normalizeProjectPath } from "@/lib/utils";

export interface ProjectHarnessSessionQueryError {
  harnessId: HarnessId;
  error: string;
}

/** Map `sessions.query` per-scope errors into hydration failures for one project. */
export function mapSessionQueryErrorsForProject(input: {
  projectKey: string;
  directory: string;
  harnessIds: readonly HarnessId[];
  queryResult: SessionQueryResult;
}): Partial<Record<HarnessId, string>> {
  const normalizedDirectory = normalizeProjectPath(input.directory);
  const scopedHarnessIds = new Set(input.harnessIds);
  const failed: Partial<Record<HarnessId, string>> = {};

  for (const entry of input.queryResult.errors ?? []) {
    if (normalizeProjectPath(entry.directory) !== normalizedDirectory) continue;
    if (!entry.harnessId || !scopedHarnessIds.has(entry.harnessId)) continue;
    if (!failed[entry.harnessId]) {
      failed[entry.harnessId] = entry.error;
    }
  }

  return failed;
}

export function listProjectHarnessSessionQueryErrors(
  hydration: { errors: Partial<Record<HarnessId, string>> } | undefined,
): ProjectHarnessSessionQueryError[] {
  if (!hydration) return [];
  return Object.entries(hydration.errors)
    .filter(
      (entry): entry is [HarnessId, string] => typeof entry[1] === "string" && entry[1].length > 0,
    )
    .map(([harnessId, error]) => ({ harnessId, error }));
}
