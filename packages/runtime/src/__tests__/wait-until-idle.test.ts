import { describe, expect, test, vi } from "vite-plus/test";
import type { HarnessEvent } from "../../../../src/agents/backend.ts";
import { harnessEventSignalsSessionIdle, waitUntilIdleViaHarness } from "../wait-until-idle.ts";

describe("waitUntilIdleViaHarness", () => {
  test("reuses onHarnessIdle without second subscribeHarnessEvents call", async () => {
    const subscribe = vi.fn(() => () => undefined);
    const idleHandlers: Array<(event: HarnessEvent) => void> = [];
    let status: "running" | "idle" = "running";

    const waiting = waitUntilIdleViaHarness({
      timeoutMs: 2_000,
      directory: "/repo",
      harnessId: "pi",
      sessionId: "pi:s1",
      getStatus: () => status,
      onIdleObserved: () => undefined,
      subscribeHarnessEvents: subscribe,
      onHarnessIdle: (handler) => {
        idleHandlers.push(handler);
        return () => {
          const i = idleHandlers.indexOf(handler);
          if (i >= 0) idleHandlers.splice(i, 1);
        };
      },
    });

    expect(subscribe).not.toHaveBeenCalled();
    status = "idle";
    for (const handler of idleHandlers) {
      handler({
        type: "session.status",
        sessionID: "s1",
        status: { type: "idle" },
      });
    }
    await waiting;
  });

  test("falls back to subscribeHarnessEvents when onHarnessIdle is omitted", async () => {
    let status: "running" | "idle" = "running";
    const subscribers = new Set<(event: HarnessEvent) => void>();

    const waiting = waitUntilIdleViaHarness({
      timeoutMs: 2_000,
      directory: "/repo",
      harnessId: "pi",
      sessionId: "pi:s1",
      getStatus: () => status,
      onIdleObserved: () => undefined,
      subscribeHarnessEvents: (handler) => {
        subscribers.add(handler);
        return () => subscribers.delete(handler);
      },
    });

    status = "idle";
    for (const handler of subscribers) {
      handler({
        type: "session.status",
        sessionID: "s1",
        status: { type: "idle" },
      });
    }
    await waiting;
  });
});

describe("harnessEventSignalsSessionIdle", () => {
  test("detects idle activity for scoped session", () => {
    const event: HarnessEvent = {
      type: "session.status",
      sessionID: "s1",
      status: { type: "idle" },
    };
    expect(
      harnessEventSignalsSessionIdle(event, {
        directory: "/repo",
        harnessId: "pi",
        sessionId: "pi:s1",
      }),
    ).toBe(true);
  });
});
