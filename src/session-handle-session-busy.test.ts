import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createSessionHandle } from "../packages/runtime/src/session-handle.ts";
import { rawSessionIdFromWire } from "../packages/runtime/src/live-session-events/live-session-scope.ts";
import {
  sessionStatusKey,
  updateSessionStatusMap,
} from "../packages/runtime/src/session-runtime-status.ts";

describe("SessionHandle SESSION_BUSY after idle status without directory", () => {
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

    const wireId = "pi:s1";
    updateSessionStatusMap({
      map,
      harnessId,
      rawId: rawSessionIdFromWire(harnessId, wireId),
      status: "idle",
      registeredDirectories: new Set([directory]),
    });

    expect(map.get(sessionStatusKey(directory, harnessId, rawId))).toBe("idle");
    await session.send("after-idle");
    expect(promptCalls).toEqual(["after-idle"]);
  });
});
