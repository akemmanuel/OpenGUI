import type { HarnessId } from "../../src/agents/index.ts";
import type { BackendServiceContext } from "./index.ts";
import { runtimeSessionBelongsToDirectory } from "./harness-scope.ts";
import { toSessionRecordInputFromRuntime } from "./runtime-session-mapper.ts";
import type { ResolvedHarnessDirectory, SessionRecord } from "./session-types.ts";

/** Harness is source of truth for session lists (ADR 0004). */
export async function listDirectorySessionsFromHarness(
  services: BackendServiceContext,
  resolved: ResolvedHarnessDirectory,
  harnessId: HarnessId,
): Promise<SessionRecord[]> {
  const scopeDirectory = resolved.canonicalPath;
  const runtimeResults = await services.harnesses.listDirectorySessions({
    directory: scopeDirectory,
    harnessIds: [harnessId],
  });
  const runtimeSessions = runtimeResults[0]?.sessions?.filter((session) =>
    runtimeSessionBelongsToDirectory(session, scopeDirectory),
  );
  if (!runtimeSessions?.length) return [];
  const records: SessionRecord[] = [];
  for (const session of runtimeSessions) {
    const input = toSessionRecordInputFromRuntime(session, {
      directory: scopeDirectory,
      harnessId,
    });
    records.push({
      ...input,
      id: input.id!,
      title: input.title ?? "Untitled",
      status: input.status ?? "unknown",
      createdAt: input.createdAt!,
      updatedAt: input.updatedAt!,
    });
  }
  return records;
}
