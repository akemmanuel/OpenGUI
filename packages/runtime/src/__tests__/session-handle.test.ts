import { describe, expect, test, vi } from "vite-plus/test";
import type { HarnessEvent } from "../../../../src/agents/backend.ts";
import { createSessionHandle, sessionIdFromCreateResult } from "../session-handle.ts";
import { rawSessionIdFromWire } from "../live-session-events/live-session-scope.ts";
import { sessionStatusKey, updateSessionStatusMap } from "../session-runtime-status.ts";
import { OpenGuiSdkError } from "../opengui-sdk-error.ts";

describe("sessionIdFromCreateResult", () => {
  test("normalizes pi session object shapes", () => {
    expect(sessionIdFromCreateResult("pi", { id: "pi:abc" })).toBe("pi:abc");
    expect(sessionIdFromCreateResult("pi", { sessionId: "raw-1" })).toBe("pi:raw-1");
    expect(sessionIdFromCreateResult("pi", { session: { id: "pi:nested" } })).toBe("pi:nested");
    expect(sessionIdFromCreateResult("pi", "raw-wire")).toBe("pi:raw-wire");
  });

  test("throws when no id", () => {
    try {
      sessionIdFromCreateResult("pi", {});
      expect.fail("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenGuiSdkError);
      expect((error as OpenGuiSdkError).code).toBe("BRIDGE_ERROR");
    }
  });
});

describe("SessionHandle", () => {
  test("send throws SESSION_BUSY when running and whileBusy is fail", async () => {
    const directory = "/tmp/project";
    const harnessId = "pi" as const;
    const rawId = "s1";
    const map = new Map<string, "idle" | "running" | "error" | "unknown">();
    map.set(sessionStatusKey(directory, harnessId, rawId), "running");

    const session = createSessionHandle({
      harnessId,
      directory,
      sessionId: "pi:s1",
      service: { promptSession: vi.fn() } as never,
      transcripts: {} as never,
      resolveSessionIds: () => ({ rawId }),
      getSessionStatus: (dir, id) => map.get(sessionStatusKey(dir, harnessId, id)),
      markSessionRunning: (dir, id) => map.set(sessionStatusKey(dir, harnessId, id), "running"),
      subscribeHarnessEvents: () => () => undefined,
    });

    await expect(session.send("hi")).rejects.toMatchObject({ code: "SESSION_BUSY" });
  });

  test("send succeeds after status map idle update from prefixed sessionID", async () => {
    const directory = "/tmp/project";
    const harnessId = "pi" as const;
    const rawId = "s1";
    const map = new Map<string, "idle" | "running" | "error" | "unknown">();
    map.set(sessionStatusKey(directory, harnessId, rawId), "running");

    const promptCalls: string[] = [];
    const session = createSessionHandle({
      harnessId,
      directory,
      sessionId: "pi:s1",
      service: {
        promptSession: async ({ text }: { text: string }) => {
          promptCalls.push(text);
        },
      } as never,
      transcripts: {} as never,
      resolveSessionIds: () => ({ rawId }),
      getSessionStatus: (dir, id) => map.get(sessionStatusKey(dir, harnessId, id)),
      markSessionRunning: (dir, id) => map.set(sessionStatusKey(dir, harnessId, id), "running"),
      markSessionIdle: (dir, id) => map.set(sessionStatusKey(dir, harnessId, id), "idle"),
      subscribeHarnessEvents: () => () => undefined,
    });

    updateSessionStatusMap({
      map,
      harnessId,
      rawId: rawSessionIdFromWire(harnessId, "pi:s1"),
      status: "idle",
      registeredDirectories: new Set([directory]),
    });

    await session.send("after-idle");
    expect(promptCalls).toEqual(["after-idle"]);
  });

  test("waitUntilIdle does not duplicate onEvent or onStream output", async () => {
    let status: "idle" | "running" = "running";
    const subscribers = new Set<(event: HarnessEvent) => void>();
    const session = createSessionHandle({
      harnessId: "pi",
      directory: "/tmp/project",
      sessionId: "pi:s1",
      service: {} as never,
      transcripts: {} as never,
      resolveSessionIds: () => ({ rawId: "s1" }),
      getSessionStatus: () => status,
      markSessionRunning: () => {
        status = "running";
      },
      subscribeHarnessEvents: (handler) => {
        subscribers.add(handler);
        return () => subscribers.delete(handler);
      },
    });
    const liveTypes: string[] = [];
    const streamTypes: string[] = [];
    const offEvent = session.onEvent((event) => liveTypes.push(event.type));
    const offStream = session.onStream((event) => streamTypes.push(event.type));

    emitHarness(subscribers, {
      type: "session.status",
      sessionID: "s1",
      status: { type: "running" },
    });
    const waiting = session.waitUntilIdle({ timeoutMs: 1_000 });
    status = "idle";
    emitHarness(subscribers, {
      type: "session.status",
      sessionID: "s1",
      status: { type: "idle" },
    });
    await waiting;

    expect(liveTypes).toEqual(["run.started", "run.finished"]);
    expect(streamTypes).toEqual(["run.start", "run.end"]);
    offEvent();
    offStream();
    session.close();
  });
});

function emitHarness(subscribers: Set<(event: HarnessEvent) => void>, event: HarnessEvent): void {
  for (const handler of subscribers) handler(event);
}
