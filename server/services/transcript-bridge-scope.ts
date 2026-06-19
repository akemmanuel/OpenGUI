import type { HarnessEvent } from "../../src/agents/backend.ts";
import type { HarnessId } from "../../src/agents/index.ts";
import { decodeCanonicalDirectorySessionId } from "../../src/lib/session-identity.ts";
import type { SessionTranscriptScope } from "@opengui/runtime";
import { transcriptSessionId } from "@opengui/runtime";
import type { BackendServiceContext } from "./index.ts";
import type { SessionRecord } from "./session-types.ts";
import { resolveSessionRecordForMutation } from "./session-resolve.ts";
import { normalizeProjectPath } from "../../src/lib/path.ts";

function normalizeDirectoryHint(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? normalizeProjectPath(value.trim()) : undefined;
}

function sessionDirectoryFromEvent(event: HarnessEvent): string | undefined {
  if ((event.type === "session.created" || event.type === "session.updated") && event.session) {
    return (
      normalizeDirectoryHint((event.session as { _projectDir?: unknown })._projectDir) ??
      normalizeDirectoryHint((event.session as { directory?: unknown }).directory)
    );
  }
  return undefined;
}

export async function resolveTranscriptScopeForBridgeEvent(
  services: BackendServiceContext,
  harnessId: HarnessId,
  event: HarnessEvent,
  resolveSafeDirectory: (path: string | null) => Promise<string>,
  bridgeDirectoryHint?: string,
): Promise<{ scope: SessionTranscriptScope; session: SessionRecord } | null> {
  const sessionId = transcriptSessionId(event);
  if (!sessionId) return null;

  const directoryHint =
    sessionDirectoryFromEvent(event) ??
    normalizeDirectoryHint(bridgeDirectoryHint) ??
    normalizeDirectoryHint(decodeCanonicalDirectorySessionId(sessionId)?.directory) ??
    undefined;

  const cached = await services.sessions.getSession(sessionId, { harnessId });
  if (cached) {
    if (!directoryHint || normalizeProjectPath(cached.directory) === directoryHint) {
      return {
        scope: { directory: cached.directory, harnessId: cached.harnessId, sessionId: cached.id },
        session: cached,
      };
    }
  }

  if (!directoryHint) return null;

  try {
    const session = await resolveSessionRecordForMutation({
      services,
      sessionId,
      scope: { directory: directoryHint, harnessId },
      resolveSafeDirectory,
    });
    return {
      scope: { directory: session.directory, harnessId: session.harnessId, sessionId: session.id },
      session,
    };
  } catch {
    return null;
  }
}
