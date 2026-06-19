import type { HarnessId } from "@/agents";
import {
  getSessionHarnessId,
  getSessionWorkspaceId,
  sortSessionsNewestFirst,
} from "@/hooks/agent-session-utils";
import type { Session } from "@/hooks/agent-state-types";
import { rawSessionIdForHarness, sameHarnessSessionIdentity } from "@/lib/session-identity";
import { normalizeProjectPath } from "@/lib/utils";

/** Keep sessions visible after live events until harness list catches up (ADR 0006 + live stream). */
export const SESSION_LIVE_RETAIN_MS = 120_000;

export interface SessionIndexMergeRetain {
  busySessionIds: ReadonlySet<string>;
  activeTurnRunBySession: Readonly<Record<string, string>>;
  liveSessionRetainUntil: Readonly<Record<string, number>>;
}

function harnessRawKey(session: Session): string | null {
  const harnessId = getSessionHarnessId(session);
  if (!harnessId) return null;
  const rawId = session._rawId ?? rawSessionIdForHarness(session.id, harnessId);
  return `${harnessId}\0${rawId}`;
}

function sessionMatchesIncoming(
  session: Session,
  incomingIds: Set<string>,
  incomingHarnessRawKeys: Set<string>,
): boolean {
  if (incomingIds.has(session.id)) return true;
  const key = harnessRawKey(session);
  return key != null && incomingHarnessRawKeys.has(key);
}

function sessionInMergeScope(
  session: Session,
  workspaceId: string,
  directory: string,
  backendScope: Set<HarnessId> | null,
): boolean {
  if (getSessionWorkspaceId(session) !== workspaceId) return false;
  const sessionDir = normalizeProjectPath((session._projectDir ?? session.directory) || "");
  if (sessionDir !== normalizeProjectPath(directory)) return false;
  if (!backendScope) return true;
  const harnessId = getSessionHarnessId(session);
  return Boolean(harnessId && backendScope.has(harnessId));
}

function shouldRetainLiveSession(sessionId: string, retain: SessionIndexMergeRetain, now: number) {
  if (retain.busySessionIds.has(sessionId)) return true;
  if (retain.activeTurnRunBySession[sessionId]) return true;
  return (retain.liveSessionRetainUntil[sessionId] ?? 0) > now;
}

export function nextLiveSessionRetainUntil(now = Date.now()): number {
  return now + SESSION_LIVE_RETAIN_MS;
}

export function mergeProjectBackendSessions({
  current,
  workspaceId,
  directory,
  incoming,
  harnessIds,
  retain,
  now = Date.now(),
}: {
  current: Session[];
  workspaceId: string;
  directory: string;
  incoming: Session[];
  harnessIds?: HarnessId[];
  retain: SessionIndexMergeRetain;
  now?: number;
}): Session[] {
  if (harnessIds && harnessIds.length === 0) return sortSessionsNewestFirst(current);

  const backendScope = harnessIds ? new Set(harnessIds) : null;
  const incomingDefined = incoming.filter(
    (session): session is Session => !!session && typeof session.id === "string",
  );
  const incomingIds = new Set(incomingDefined.map((session) => session.id));
  const incomingHarnessRawKeys = new Set(
    incomingDefined.flatMap((session) => {
      const key = harnessRawKey(session);
      return key ? [key] : [];
    }),
  );

  const kept = current.filter((session) => {
    if (sessionMatchesIncoming(session, incomingIds, incomingHarnessRawKeys)) {
      return false;
    }
    if (!sessionInMergeScope(session, workspaceId, directory, backendScope)) {
      return true;
    }
    if (shouldRetainLiveSession(session.id, retain, now)) {
      return true;
    }
    return false;
  });

  return sortSessionsNewestFirst([...kept, ...incomingDefined]);
}

export function upsertSessionInList(current: Session[], incoming: Session): Session[] {
  const same = (a: Session, b: Session) =>
    sameHarnessSessionIdentity(
      { id: a.id, _harnessId: getSessionHarnessId(a) ?? undefined, _rawId: a._rawId },
      { id: b.id, _harnessId: getSessionHarnessId(b) ?? undefined, _rawId: b._rawId },
    );
  return sortSessionsNewestFirst([
    incoming,
    ...current.filter((session) => !same(session, incoming)),
  ]);
}
