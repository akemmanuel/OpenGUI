import type { Session } from "@/hooks/agent-state-types";
import type { HostSessionSnapshot } from "@/protocol/host-types";
import type { SelectedModel } from "@opengui/protocol";

export function selectedModelFromHostSnapshot(snapshot: HostSessionSnapshot): SelectedModel | null {
  if (!snapshot.model) return null;
  return {
    providerID: snapshot.model.connectionId,
    modelID: snapshot.model.modelId,
  };
}

/** Reconcile the Host-authoritative model into the session collection used by sidebar surfaces. */
export function applyHostModelSnapshot(
  sessions: Session[],
  snapshot: HostSessionSnapshot,
): Session[] {
  const index = sessions.findIndex((session) => session.id === snapshot.id);
  if (index < 0) return sessions;
  const current = sessions[index]!;
  const updatedAt = Date.parse(snapshot.updatedAt);
  const next = [...sessions];
  next[index] = {
    ...current,
    model: snapshot.model
      ? { providerID: snapshot.model.connectionId, id: snapshot.model.modelId }
      : undefined,
    time: {
      ...current.time,
      ...(Number.isNaN(updatedAt) ? {} : { updated: updatedAt }),
    },
  };
  return next;
}
