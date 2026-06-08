import type { HarnessId } from "../../src/agents/index.ts";
import type { BackendServiceContext, ProjectRecord, SessionRecord } from "./index.ts";
import { buildHarnessScope, runtimeSessionBelongsToProject } from "./harness-scope.ts";
import { toSessionRecordInputFromRuntime } from "./runtime-session-mapper.ts";

export interface ResolvedHarnessDirectory {
  directory: string;
  canonicalPath: string;
}

export async function syncDirectorySessions(
  services: BackendServiceContext,
  directory: ResolvedHarnessDirectory,
  harnessId: HarnessId,
): Promise<{ sessions: SessionRecord[]; nextCursor: null }> {
  const projectId = directory.canonicalPath;
  const runtimeResults = await services.harnesses.listProjectSessions({
    scope: { projectId, directory: directory.canonicalPath },
    harnessIds: [harnessId],
  });
  const runtimeSessions = runtimeResults[0]?.sessions?.filter((session) =>
    runtimeSessionBelongsToProject(session, directory.canonicalPath),
  );
  if (!runtimeSessions) {
    const page = await services.sessions.listSessions({ projectId, harnessId });
    return { sessions: page.sessions, nextCursor: null };
  }
  const sessions = await services.sessions.replaceScopeSessions(
    { projectId, harnessId },
    runtimeSessions.map((session) =>
      toSessionRecordInputFromRuntime(session, {
        projectId,
        harnessId,
      }),
    ),
  );
  return { sessions, nextCursor: null };
}

export async function syncProjectSessions(
  services: BackendServiceContext,
  project: ProjectRecord,
  harnessId: HarnessId,
): Promise<{ sessions: SessionRecord[]; nextCursor: string | null }> {
  const runtimeResults = await services.harnesses.listProjectSessions({
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
