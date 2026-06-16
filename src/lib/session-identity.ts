import type { HarnessId } from "../agents/index.ts";

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

// Keep this list local instead of importing HARNESS_IDS from ../agents/index.ts.
// The agents index re-exports createBackendIdCodec, which depends on this file;
// importing its runtime constants here creates a production Rollup cycle where
// HARNESS_IDS can be read before it is initialized.
const SESSION_ID_HARNESS_IDS: HarnessId[] = ["opencode", "claude-code", "pi", "codex"];

export function composeFrontendSessionId(harnessId: HarnessId, rawId: string): string {
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
  projectId: string;
  harnessId: HarnessId;
  rawId: string;
}): string {
  return [input.projectId, input.harnessId, input.rawId].join("::");
}

export function harnessRawSessionKey(harnessId: HarnessId, rawId: string): string {
  return `${harnessId}::${rawId}`;
}
