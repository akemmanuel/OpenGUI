export type SessionEntryDecision =
  | { type: "use-active-session"; sessionId: string }
  | { type: "start-draft-session"; directory: string }
  | { type: "create-session-from-draft"; directory: string }
  | { type: "missing-session" };

export function decideSessionEntry({
  activeSessionId,
  draftDirectory,
  canStartSession,
}: {
  activeSessionId: string | null | undefined;
  draftDirectory: string | null | undefined;
  canStartSession: boolean;
}): SessionEntryDecision {
  if (activeSessionId) {
    return { type: "use-active-session", sessionId: activeSessionId };
  }

  if (!draftDirectory) {
    return { type: "missing-session" };
  }

  if (canStartSession) {
    return { type: "start-draft-session", directory: draftDirectory };
  }

  return { type: "create-session-from-draft", directory: draftDirectory };
}
