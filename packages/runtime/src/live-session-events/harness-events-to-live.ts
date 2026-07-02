import type { HarnessEvent } from "../../../../src/agents/backend.ts";
import type { HarnessId } from "../../../../src/agents/index.ts";
import { harnessEventToAdapterObservations } from "./live-session-event-compat.ts";
import type { LiveSessionEvent } from "./live-session-event.ts";
import { LiveSessionEventBus } from "./live-session-event-bus.ts";

/**
 * Single ingress: native harness events → normalized LiveSessionEvent[].
 * Replaces ad-hoc chains of compat → bus → normalizer at call sites.
 */
export function harnessEventsToLiveSessionEvents(input: {
  directory: string;
  harnessId: HarnessId;
  event: HarnessEvent;
  bus?: LiveSessionEventBus;
}): LiveSessionEvent[] {
  const observations = harnessEventToAdapterObservations(input);
  if (!observations.length) return [];
  const bus = input.bus ?? new LiveSessionEventBus();
  return bus.publish(observations);
}
