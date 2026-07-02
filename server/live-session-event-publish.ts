import type { HarnessEvent } from "../src/agents/backend.ts";
import type { HarnessId } from "../src/agents/index.ts";
import type { LiveSessionEvent } from "../packages/runtime/src/live-session-events/live-session-event.ts";
import { harnessEventsToLiveSessionEvents, LiveSessionEventBus } from "@opengui/runtime";
import type { BackendServiceContext } from "./services/index.ts";

const sharedLiveSessionBus = new LiveSessionEventBus();

export function publishLiveSessionHarnessEvent(
  services: Pick<BackendServiceContext, "events">,
  input: { directory: string; harnessId: HarnessId; event: HarnessEvent },
  bus: LiveSessionEventBus = sharedLiveSessionBus,
): LiveSessionEvent[] {
  const published: LiveSessionEvent[] = [];
  for (const event of harnessEventsToLiveSessionEvents({ ...input, bus })) {
    services.events.publish(event.type, event, {
      directory: event.scope.directory,
      sessionId: event.scope.sessionId,
      harnessId: event.scope.harnessId,
    });
    published.push(event);
  }
  return published;
}
