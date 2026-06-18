import type { HarnessId } from "@opengui/protocol";
import { resolve } from "node:path";
import type { DirectoryScopeRef } from "@opengui/runtime";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function buildHarnessScope(input: {
  scopeRef: DirectoryScopeRef;
  harnessId: HarnessId;
  sessionId?: string;
}) {
  const directory = input.scopeRef.canonicalPath || input.scopeRef.path;
  return {
    sessionId: input.sessionId,
    harnessId: input.harnessId,
    directory,
  };
}

export function runtimeSessionBelongsToDirectory(session: unknown, directoryPath: string) {
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
  return resolve(directory) === resolve(directoryPath);
}
