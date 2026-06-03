import type { HarnessId } from "../../src/agents/index.ts";
import type { BackendServiceContext, ProjectRecord } from "./index.ts";
import { runJobsWithConcurrency } from "./concurrency.ts";
import { listSessionRecords } from "./session-record-actions.ts";
import { syncProjectSessions } from "./session-sync.ts";
import { getProjectRecordOrThrow } from "./project-record-actions.ts";

export interface ResolvedSessionQueryProject {
  frontendProjectId: string;
  project: ProjectRecord;
}

export async function querySessionsForResolvedProjects(input: {
  services: BackendServiceContext;
  projects: ResolvedSessionQueryProject[];
  harnessIds: HarnessId[];
  sync: boolean;
}) {
  const sessionJobs = input.projects.flatMap(({ frontendProjectId, project }) =>
    input.harnessIds.map((harnessId) => async () => {
      try {
        const page = input.sync
          ? await syncProjectSessions(input.services, project, harnessId)
          : await listSessionRecords({
              services: input.services,
              projectId: project.id,
              harnessId,
            });
        return {
          ok: true as const,
          item: {
            frontendProjectId,
            directory: project.path,
            harnessId,
            sessions: page.sessions,
          },
        };
      } catch (error) {
        return {
          ok: false as const,
          error: {
            frontendProjectId,
            directory: project.path,
            harnessId,
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }),
  );

  const sessionResults = await runJobsWithConcurrency(sessionJobs, 4);
  return {
    items: sessionResults
      .filter((result): result is Extract<typeof result, { ok: true }> => result.ok)
      .map((result) => result.item),
    errors: sessionResults
      .filter((result): result is Extract<typeof result, { ok: false }> => !result.ok)
      .map((result) => result.error),
  };
}

export async function listSessionsForRequest(input: {
  services: BackendServiceContext;
  projectId?: string;
  harnessId?: HarnessId;
  sync: boolean;
  cursor?: string | null;
  limit?: number;
}) {
  if (input.projectId && input.harnessId && input.sync) {
    return await syncProjectSessions(
      input.services,
      await getProjectRecordOrThrow({ services: input.services, projectId: input.projectId }),
      input.harnessId,
    );
  }

  return await listSessionRecords({
    services: input.services,
    projectId: input.projectId,
    harnessId: input.harnessId,
    cursor: input.cursor,
    limit: input.limit,
  });
}
