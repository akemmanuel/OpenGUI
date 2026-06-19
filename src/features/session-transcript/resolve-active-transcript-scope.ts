import { getHarnessIdFromSessionId } from "@/agents";
import {
  getEffectiveSessionDirectory,
  getSessionHarnessId,
  getSessionProjectTarget,
} from "@/hooks/agent-session-utils";
import type { Session } from "@/hooks/agent-state-types";
import type { SessionMetaMap } from "@/hooks/agent-state-persistence";
import { normalizeProjectPath } from "@/lib/utils";
import type { ActiveTranscriptScope } from "@/features/session-transcript/transcript-input";

export function resolveActiveTranscriptScope(input: {
  sessionId: string | null;
  sessions: Session[];
  sessionMeta: SessionMetaMap;
}): ActiveTranscriptScope | null {
  const { sessionId, sessions, sessionMeta } = input;
  if (!sessionId) return null;
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) return null;

  const target = getSessionProjectTarget(session, sessionMeta[session.id]);
  const directory = normalizeProjectPath(
    target?.directory ??
      getEffectiveSessionDirectory(session, sessionMeta[session.id]) ??
      session._projectDir ??
      session.directory ??
      "",
  );
  if (!directory) return null;

  const harnessId = getSessionHarnessId(session) ?? getHarnessIdFromSessionId(sessionId) ?? null;
  if (!harnessId) return null;

  return {
    directory,
    harnessId,
    sessionId,
  };
}
