export type SessionEntryDecision =
  | { type: "use-active-session"; sessionId: string }
  | { type: "missing-session" };

export function decideSessionEntry({
  activeSessionId,
}: {
  activeSessionId: string | null | undefined;
}): SessionEntryDecision {
  if (activeSessionId) {
    return { type: "use-active-session", sessionId: activeSessionId };
  }

  return { type: "missing-session" };
}
