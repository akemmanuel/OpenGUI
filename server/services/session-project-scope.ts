import { basename } from "node:path";
import type { BackendServiceContext, ProjectRecord } from "./index.ts";
import type { SessionRecord } from "./session-types.ts";

function sessionMetadataDirectory(session: SessionRecord): string | undefined {
  const value =
    session.metadata && typeof session.metadata.directory === "string"
      ? session.metadata.directory.trim()
      : "";
  return value || undefined;
}

function looksLikeFilesystemProjectId(projectId: string): boolean {
  return projectId.startsWith("/") || projectId.startsWith("~");
}

/**
 * Resolves the Project scope for a Session index record.
 * Session.projectId is often a canonical filesystem path while connected Projects use opaque storage ids.
 */
export async function resolveSessionProjectRecord(input: {
  services: BackendServiceContext;
  session: SessionRecord;
  resolveSafeDirectory: (path: string) => Promise<string>;
}): Promise<ProjectRecord> {
  const storedProject = await input.services.projects.getProject(input.session.projectId);
  if (storedProject) return storedProject;

  const metadataDirectory = sessionMetadataDirectory(input.session);
  const pathHint =
    metadataDirectory ??
    (looksLikeFilesystemProjectId(input.session.projectId) ? input.session.projectId : undefined);

  if (pathHint) {
    const directory = await input.resolveSafeDirectory(pathHint);
    const byPath = await input.services.projects.findProjectByPath({
      path: directory,
      canonicalPath: directory,
    });
    if (byPath) return byPath;

    const now = new Date().toISOString();
    return {
      id: directory,
      displayName: basename(directory),
      path: directory,
      canonicalPath: directory,
      createdAt: now,
      updatedAt: now,
    };
  }

  throw new Error("Project not found");
}
