import { resolve } from "node:path";
import type { HarnessId } from "../../src/agents/index.ts";
import type { ProjectRecord } from "./storage-service.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function buildHarnessScope(input: {
  project: ProjectRecord;
  harnessId: HarnessId;
  sessionId?: string;
}) {
  return {
    projectId: input.project.id,
    sessionId: input.sessionId,
    harnessId: input.harnessId,
    directory: input.project.path,
  };
}

export function runtimeSessionBelongsToProject(session: unknown, projectPath: string) {
  if (!isPlainObject(session)) return true;
  const directory =
    typeof session.directory === "string"
      ? session.directory
      : typeof session._projectDir === "string"
        ? session._projectDir
        : typeof session.projectID === "string"
          ? session.projectID
          : typeof session.metadata === "object" &&
              session.metadata &&
              typeof (session.metadata as Record<string, unknown>).directory === "string"
            ? ((session.metadata as Record<string, unknown>).directory as string)
            : null;
  if (!directory) return true;
  return resolve(directory) === resolve(projectPath);
}
