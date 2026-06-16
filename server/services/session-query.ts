import type { HarnessId } from "../../src/agents/index.ts";
import type { BackendServiceContext } from "./index.ts";
import { runJobsWithConcurrency } from "./concurrency.ts";
import { listSessionRecords } from "./session-record-actions.ts";
import { syncDirectorySessions, syncProjectSessions } from "./session-sync.ts";
import { getProjectRecordOrThrow } from "./project-record-actions.ts";

export interface ResolvedSessionQueryProject {
  directory: string;
  canonicalPath: string;
}

export interface SessionQueryProjectError {
  directory?: string;
  harnessId?: HarnessId;
  error: string;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function querySessionsForResolvedProjects(input: {
  services: BackendServiceContext;
  projects: ResolvedSessionQueryProject[];
  harnessIds: HarnessId[];
  sync: boolean;
}) {
  const sessionJobs = input.projects.flatMap(({ directory, canonicalPath }) =>
    input.harnessIds.map((harnessId) => async () => {
      try {
        const page = input.sync
          ? await syncDirectorySessions(input.services, { directory, canonicalPath }, harnessId)
          : await listSessionRecords({
              services: input.services,
              projectId: canonicalPath,
              harnessId,
            });
        return {
          ok: true as const,
          item: {
            directory,
            harnessId,
            sessions: page.sessions,
          },
        };
      } catch (error) {
        return {
          ok: false as const,
          error: {
            directory,
            harnessId,
            error: errorMessage(error),
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

export async function querySessionsFromFrontendProjects(input: {
  services: BackendServiceContext;
  body: Record<string, unknown>;
  isHarnessId: (value: unknown) => value is HarnessId;
  resolveDirectory: (directory: string) => Promise<{ directory: string; canonicalPath: string }>;
}) {
  const projectsInput = Array.isArray(input.body.projects) ? input.body.projects : [];
  const harnessIds = Array.isArray(input.body.harnessIds)
    ? input.body.harnessIds.filter(input.isHarnessId)
    : [];
  const resolved = await Promise.all(
    projectsInput.map(
      async (
        projectInput,
      ): Promise<
        | { ok: true; item: ResolvedSessionQueryProject }
        | { ok: false; error: SessionQueryProjectError }
        | undefined
      > => {
        if (!projectInput || typeof projectInput !== "object" || Array.isArray(projectInput))
          return;
        const record = projectInput as Record<string, unknown>;
        const directory = typeof record.directory === "string" ? record.directory.trim() : "";
        if (!directory) return;
        try {
          return {
            ok: true as const,
            item: await input.resolveDirectory(directory),
          };
        } catch (error) {
          return {
            ok: false as const,
            error: { directory, error: errorMessage(error) },
          };
        }
      },
    ),
  );
  const projects = resolved.flatMap((result) => (result?.ok ? [result.item] : []));
  const errors = resolved.flatMap((result) => (result && !result.ok ? [result.error] : []));

  const queried = await querySessionsForResolvedProjects({
    services: input.services,
    projects,
    harnessIds,
    sync: input.body.sync === true,
  });
  return { items: queried.items, errors: [...errors, ...queried.errors] };
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
