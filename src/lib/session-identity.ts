import type { AgentBackendId } from "../agents/index.ts";

export type SessionIdentityScope = {
  projectId?: string;
  harnessId?: AgentBackendId;
};

export type SessionIdentityLike = {
  id: string;
  _backendId?: AgentBackendId;
  _rawId?: string;
};

const KNOWN_HARNESS_IDS = ["opencode", "claude-code", "pi", "codex"] as const;

export function composeFrontendSessionId(harnessId: AgentBackendId, rawId: string): string {
  const marker = `${harnessId}:`;
  return rawId.startsWith(marker) ? rawId : `${marker}${rawId}`;
}

export function parseFrontendSessionId(
  sessionId: string,
): { harnessId: AgentBackendId; rawId: string } | null {
  for (const harnessId of KNOWN_HARNESS_IDS) {
    const marker = `${harnessId}:`;
    if (sessionId.startsWith(marker)) return { harnessId, rawId: sessionId.slice(marker.length) };
  }
  return null;
}

export function rawSessionIdForHarness(sessionId: string, harnessId: AgentBackendId): string {
  const parsed = parseFrontendSessionId(sessionId);
  return parsed?.harnessId === harnessId ? parsed.rawId : sessionId;
}

export function backendSessionIdentity(session: SessionIdentityLike): string {
  const harnessId = session._backendId ?? parseFrontendSessionId(session.id)?.harnessId;
  if (!harnessId) return session.id;
  const rawId = session._rawId ?? rawSessionIdForHarness(session.id, harnessId);
  return composeFrontendSessionId(harnessId, rawId);
}

export function sameBackendSessionIdentity(
  left: SessionIdentityLike,
  right: SessionIdentityLike,
): boolean {
  return backendSessionIdentity(left) === backendSessionIdentity(right);
}

export function scopedRawSessionKey(input: {
  projectId: string;
  harnessId: AgentBackendId;
  rawId: string;
}): string {
  return [input.projectId, input.harnessId, input.rawId].join("::");
}

export function harnessRawSessionKey(harnessId: AgentBackendId, rawId: string): string {
  return `${harnessId}::${rawId}`;
}
