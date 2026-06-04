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
  activeTargetBackendId,
  preferredBackendId,
}: {
  activeTargetBackendId: HarnessId | null;
  preferredBackendId: HarnessId;
}): HarnessRoute {
  if (activeTargetBackendId) {
    return { harnessId: activeTargetBackendId, reason: "active-target", locked: false };
  }
  return { harnessId: preferredBackendId, reason: "preferred", locked: false };
}

export function resolveActiveResourceHarnessRoute({
  activeSession,
  activeTargetBackendId,
  preferredBackendId,
}: {
  activeSession: Session | null | undefined;
  activeTargetBackendId: HarnessId | null;
  preferredBackendId: HarnessId;
}): HarnessRoute {
  const sessionBackendId = getSessionHarnessId(activeSession);
  if (sessionBackendId) {
    return { harnessId: sessionBackendId, reason: "session", locked: true };
  }
  if (activeTargetBackendId) {
    return { harnessId: activeTargetBackendId, reason: "active-target", locked: false };
  }
  return { harnessId: preferredBackendId, reason: "preferred", locked: false };
}
