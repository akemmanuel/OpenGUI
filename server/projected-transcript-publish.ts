import type { ProjectedTranscriptEvent } from "@opengui/runtime";
import type { BackendServiceContext } from "./services/index.ts";

export function publishProjectedTranscriptEvent(
  services: Pick<BackendServiceContext, "events">,
  projected: ProjectedTranscriptEvent,
): boolean {
  if (projected.type === "transcript.message") return false;

  const refs = {
    directory: projected.scope.directory,
    sessionId: projected.scope.sessionId,
    harnessId: projected.scope.harnessId,
  };
  services.events.publish(projected.type, projected, refs);
  return true;
}
