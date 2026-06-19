import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import type { HarnessEvent } from "@/agents/backend";
import { createSessionTranscripts } from "@opengui/runtime";
import { BackendEventBus } from "../server/services/event-bus.ts";
import { SessionDispatchIndex } from "../server/services/session-dispatch-index.ts";
import type { BackendServiceContext } from "../server/services/index.ts";
import { resolveTranscriptScopeForBridgeEvent } from "../server/services/transcript-bridge-scope.ts";
import { listDirectorySessionsFromHarness } from "../server/services/session-harness-list.ts";

vi.mock("../server/services/session-harness-list.ts", () => ({
  listDirectorySessionsFromHarness: vi.fn(),
}));

const harnessId = "pi" as const;
const directory = "/repo";
const sessionId = "pi:s1";

function messageUpdatedEvent(): HarnessEvent {
  return {
    type: "message.updated",
    message: {
      id: "m1",
      sessionID: sessionId,
      role: "assistant",
      time: { created: 1 },
      providerID: "",
      modelID: "",
    },
  };
}

describe("resolveTranscriptScopeForBridgeEvent", () => {
  test("warms dispatch index from harness when cache miss and bridge directory hint is set", async () => {
    const storage = {
      listSessionMappings: async () => [],
      upsertSessionMapping: async () => {},
      deleteSessionMapping: async () => {},
    } as unknown as BackendServiceContext["storage"];
    const events = new BackendEventBus();
    const sessions = new SessionDispatchIndex(storage, events);
    const services = {
      sessions,
      harnesses: {} as BackendServiceContext["harnesses"],
      transcripts: createSessionTranscripts(),
      storage,
      events,
    } as BackendServiceContext;

    vi.mocked(listDirectorySessionsFromHarness).mockResolvedValue([
      {
        id: sessionId,
        rawId: "s1",
        directory,
        harnessId,
        title: "Test",
        status: "idle",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    const resolveSafeDirectory = async (path: string | null) => path ?? directory;

    const result = await resolveTranscriptScopeForBridgeEvent(
      services,
      harnessId,
      messageUpdatedEvent(),
      resolveSafeDirectory,
      directory,
    );

    expect(result).toMatchObject({
      scope: { directory, harnessId, sessionId },
    });
    expect(await sessions.getSession(sessionId, { harnessId })).not.toBeNull();
  });
});
