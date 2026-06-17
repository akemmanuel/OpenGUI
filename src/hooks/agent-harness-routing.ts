import type { HarnessId } from "@/agents";
import { getSessionHarnessId } from "@/hooks/agent-session-utils";
import type { Session } from "@/hooks/agent-state-types";

export type HarnessRouteReason = "session" | "active-target" | "preferred";

export type HarnessRoute = {
  harnessId: HarnessId;
  reason: HarnessRouteReason;
  locked: boolean;
};

export type SessionHarnessRoute = {
  harnessId: HarnessId | null;
  reason: "session" | null;
  locked: true;
};

export function resolveSessionHarnessRoute(
  session: Session | null | undefined,
): SessionHarnessRoute {
  const harnessId = getSessionHarnessId(session);
  return {
    harnessId,
    reason: harnessId ? "session" : null,
    locked: true,
  };
}

export function resolvePendingPromptCreationHarnessRoute({
  activeTargetHarnessId,
  preferredHarnessId,
}: {
  activeTargetHarnessId: HarnessId | null;
  preferredHarnessId: HarnessId;
}): HarnessRoute {
  if (activeTargetHarnessId) {
    return { harnessId: activeTargetHarnessId, reason: "active-target", locked: false };
  }
  return { harnessId: preferredHarnessId, reason: "preferred", locked: false };
}

export function resolveActiveResourceHarnessRoute({
  activeSession,
  activeTargetHarnessId,
  preferredHarnessId,
}: {
  activeSession: Session | null | undefined;
  activeTargetHarnessId: HarnessId | null;
  preferredHarnessId: HarnessId;
}): HarnessRoute {
  const sessionHarnessId = getSessionHarnessId(activeSession);
  if (sessionHarnessId) {
    return { harnessId: sessionHarnessId, reason: "session", locked: true };
  }
  if (activeTargetHarnessId) {
    return { harnessId: activeTargetHarnessId, reason: "active-target", locked: false };
  }
  return { harnessId: preferredHarnessId, reason: "preferred", locked: false };
}
