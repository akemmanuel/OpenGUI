import type { AgentBackendId } from "@/agents";
import { getSessionBackendId } from "@/hooks/agent-session-utils";
import type { Session } from "@/hooks/agent-state-types";

export type HarnessRouteReason = "session" | "active-target" | "preferred";

export type HarnessRoute = {
  harnessId: AgentBackendId;
  reason: HarnessRouteReason;
  locked: boolean;
};

export type SessionHarnessRoute = {
  harnessId: AgentBackendId | null;
  reason: "session" | null;
  locked: true;
};

export function resolveSessionHarnessRoute(
  session: Session | null | undefined,
): SessionHarnessRoute {
  const harnessId = getSessionBackendId(session);
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
  activeTargetBackendId: AgentBackendId | null;
  preferredBackendId: AgentBackendId;
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
  activeTargetBackendId: AgentBackendId | null;
  preferredBackendId: AgentBackendId;
}): HarnessRoute {
  const sessionBackendId = getSessionBackendId(activeSession);
  if (sessionBackendId) {
    return { harnessId: sessionBackendId, reason: "session", locked: true };
  }
  if (activeTargetBackendId) {
    return { harnessId: activeTargetBackendId, reason: "active-target", locked: false };
  }
  return { harnessId: preferredBackendId, reason: "preferred", locked: false };
}
