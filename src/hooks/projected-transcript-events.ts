import type { ProjectedTranscriptEvent } from "@opengui/runtime/client";
import type { BackendEventEnvelope } from "@/hooks/backend-event-normalization";
import { normalizeProjectPath } from "@/lib/utils";
import { makeProjectKey, parseProjectKey } from "@/hooks/agent-session-utils";

function hasTranscriptScope(value: unknown): value is ProjectedTranscriptEvent["scope"] {
  if (!value || typeof value !== "object") return false;
  const scope = value as Record<string, unknown>;
  return (
    typeof scope.directory === "string" &&
    typeof scope.harnessId === "string" &&
    typeof scope.sessionId === "string"
  );
}

/** SSE envelopes for server-projected transcript pages (not harness-native part events). */
export function isProjectedTranscriptEnvelope(
  event: BackendEventEnvelope,
): event is BackendEventEnvelope & { type: ProjectedTranscriptEvent["type"] } {
  return event.type === "transcript.snapshot" || event.type === "transcript.message.removed";
}

export function tryParseProjectedTranscriptEvent(
  event: BackendEventEnvelope,
): ProjectedTranscriptEvent | null {
  if (!isProjectedTranscriptEnvelope(event)) return null;
  if (!hasTranscriptScope(event.scope)) return null;
  return event as unknown as ProjectedTranscriptEvent;
}

export function isExpectedProjectedTranscriptScope(
  scope: ProjectedTranscriptEvent["scope"],
  expectedProjectKeys: Set<string>,
): boolean {
  const normalizedDirectory = normalizeProjectPath(scope.directory);
  return [...expectedProjectKeys].some(
    (projectKey) =>
      normalizeProjectPath(parseProjectKey(projectKey).directory) === normalizedDirectory,
  );
}

export function isExpectedProjectEvent(input: {
  directory: string;
  workspaceId?: string;
  expectedProjectKeys: Set<string>;
}): boolean {
  const { directory, workspaceId, expectedProjectKeys } = input;
  if (workspaceId && expectedProjectKeys.has(makeProjectKey(workspaceId, directory))) return true;
  if (workspaceId) return false;

  const normalizedDirectory = normalizeProjectPath(directory);
  return [...expectedProjectKeys].some(
    (projectKey) =>
      normalizeProjectPath(parseProjectKey(projectKey).directory) === normalizedDirectory,
  );
}
