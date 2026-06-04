import type { HarnessId } from "../../src/agents/index.ts";
import type { BackendServiceContext, ProjectRecord, SessionRecord } from "./index.ts";
import { buildHarnessScope, runtimeSessionBelongsToProject } from "./harness-scope.ts";
import { toSessionRecordInputFromRuntime } from "./runtime-session-mapper.ts";

export async function syncProjectSessions(
  services: BackendServiceContext,
  project: ProjectRecord,
  harnessId: HarnessId,
): Promise<{ sessions: SessionRecord[]; nextCursor: string | null }> {
  const runtimeResults = await services.harnesses.listProjectSessions({
    project,
    scope: buildHarnessScope({ project, harnessId }),
    harnessIds: [harnessId],
  });
  const runtimeSessions = runtimeResults[0]?.sessions?.filter((session) =>
    runtimeSessionBelongsToProject(session, project.path),
  );
  if (!runtimeSessions) {
    return await services.sessions.listSessions({
      projectId: project.id,
      harnessId,
    });
  }
  const sessions = await services.sessions.replaceScopeSessions(
    {
      projectId: project.id,
      harnessId,
    },
    runtimeSessions.map((session) =>
      toSessionRecordInputFromRuntime(session, {
        projectId: project.id,
        harnessId,
      }),
    ),
  );
  return { sessions, nextCursor: null };
}
