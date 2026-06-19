import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { HarnessEvent } from "@/agents/backend";
import { LiveSessionEventBus } from "@opengui/runtime";
import { BackendEventBus } from "../server/services/event-bus.ts";
import { publishLiveSessionHarnessEvent } from "../server/live-session-event-publish.ts";

const directory = "/repo";
const harnessId = "pi" as const;
const sessionId = "pi:s1";

describe("session.status canonical fallback policy", () => {
  test("retry status produces no live events and should still reach canonical bus", () => {
    const events = new BackendEventBus();
    const bus = new LiveSessionEventBus();
    const published: string[] = [];
    events.subscribe((envelope) => published.push(envelope.type));

    const retry: HarnessEvent = {
      type: "session.status",
      sessionID: sessionId,
      status: { type: "retry" },
    };

    const live = publishLiveSessionHarnessEvent(
      { events },
      { directory, harnessId, event: retry },
      bus,
    );
    expect(live).toHaveLength(0);

    events.publish("session.status", retry, { harnessId, sessionId, directory });
    expect(published).toEqual(["session.status"]);
  });
});
