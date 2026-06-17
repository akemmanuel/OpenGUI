import type { HarnessId } from "../agents/harness-ids.ts";
import { HARNESS_ID_VALUES } from "../agents/harness-ids.ts";

export type SessionIdentityScope = {
  projectId?: string;
  harnessId?: HarnessId;
};

export type SessionIdentityLike = {
  id: string;
  _harnessId?: HarnessId;
  /** Legacy name used by releases before the Harness terminology migration. */
  _backendId?: HarnessId;
  _rawId?: string;
};

// Leaf ids from harness-ids.ts (no codec / index cycle).
const SESSION_ID_HARNESS_IDS: HarnessId[] = [...HARNESS_ID_VALUES];

export function composeFrontendSessionId(harnessId: HarnessId, rawId: string): string {
  if (typeof rawId !== "string" || rawId.length === 0) {
    throw new Error(`composeFrontendSessionId: missing raw session id for harness "${harnessId}"`);
  }
  const marker = `${harnessId}:`;
  return rawId.startsWith(marker) ? rawId : `${marker}${rawId}`;
}

export function parseFrontendSessionId(
  sessionId: string,
): { harnessId: HarnessId; rawId: string } | null {
  for (const harnessId of SESSION_ID_HARNESS_IDS) {
    const marker = `${harnessId}:`;
    if (sessionId.startsWith(marker)) return { harnessId, rawId: sessionId.slice(marker.length) };
  }
  return null;
}

/** Legacy backend index id (`session_<base64url>`). Prefer `composeFrontendSessionId` for new records. */
export function decodeCanonicalDirectorySessionId(
  sessionId: string,
): { directory: string; harnessId: HarnessId; rawId: string } | null {
  if (!sessionId.startsWith("session_")) return null;
  try {
    const decoded = Buffer.from(sessionId.slice("session_".length), "base64url").toString("utf8");
    const [directory, harnessId, rawId] = decoded.split("::");
    if (!directory || !rawId) return null;
    if (!SESSION_ID_HARNESS_IDS.includes(harnessId as HarnessId)) return null;
    return { directory, harnessId: harnessId as HarnessId, rawId };
  } catch {
    return null;
  }
}

export function resolveWireSessionIdentity(
  sessionId: string,
  scopeHarnessId?: HarnessId,
): { harnessId: HarnessId; rawId: string; wireId: string } | null {
  const parsed = parseFrontendSessionId(sessionId);
  if (parsed) {
    return { ...parsed, wireId: composeFrontendSessionId(parsed.harnessId, parsed.rawId) };
  }
  const legacy = decodeCanonicalDirectorySessionId(sessionId);
  if (legacy) {
    return {
      harnessId: legacy.harnessId,
      rawId: legacy.rawId,
      wireId: composeFrontendSessionId(legacy.harnessId, legacy.rawId),
    };
  }
  if (scopeHarnessId) {
    return {
      harnessId: scopeHarnessId,
      rawId: sessionId,
      wireId: composeFrontendSessionId(scopeHarnessId, sessionId),
    };
  }
  return null;
}

export function rawSessionIdForHarness(sessionId: string, harnessId: HarnessId): string {
  const parsed = parseFrontendSessionId(sessionId);
  return parsed?.harnessId === harnessId ? parsed.rawId : sessionId;
}

export function harnessSessionIdentity(session: SessionIdentityLike): string {
  const harnessId =
    session._harnessId ?? session._backendId ?? parseFrontendSessionId(session.id)?.harnessId;
  if (!harnessId) return session.id;
  const rawId = session._rawId ?? rawSessionIdForHarness(session.id, harnessId);
  return composeFrontendSessionId(harnessId, rawId);
}

export function sameHarnessSessionIdentity(
  left: SessionIdentityLike,
  right: SessionIdentityLike,
): boolean {
  return harnessSessionIdentity(left) === harnessSessionIdentity(right);
}

export function scopedRawSessionKey(input: {
  directory: string;
  harnessId: HarnessId;
  rawId: string;
}): string {
  return [input.directory, input.harnessId, input.rawId].join("::");
}

export function harnessRawSessionKey(harnessId: HarnessId, rawId: string): string {
  return `${harnessId}::${rawId}`;
}
