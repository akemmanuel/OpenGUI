import { describe, expect, test, vi } from "vite-plus/test";
import { PiBridgeManager } from "../pi-bridge.ts";
import type { PiLiveSessionLike, PiSessionManagerLike } from "../pi-bridge-types.ts";
import { registerPiBridgeProjectForTests } from "../pi-project-slot.ts";

function noopSubscribe() {
  return () => undefined;
}

describe("PiBridgeManager abort", () => {
  test("signals active Pi sessions without waiting for Pi settle listeners", async () => {
    const manager = new PiBridgeManager(() => []);
    const sent: unknown[] = [];
    manager.sendNativeEvent = (event: unknown) => sent.push(event);
    const project = registerPiBridgeProjectForTests(manager, { directory: "/repo" });
    project.busySessionIds.add("s1");

    const abort = vi.fn(() => new Promise<void>(() => undefined));
    const sessionManager = {
      getBranch: () => [],
      getSessionId: () => "s1",
      getCwd: () => "/repo",
      getSessionName: () => "s1",
      getHeader: () => ({ timestamp: new Date().toISOString() }),
    };
    const session: PiLiveSessionLike & { abort: () => Promise<void> } = {
      sessionId: "s1",
      isStreaming: true,
      sessionManager,
      subscribe: noopSubscribe,
      abort,
    };
    const runtime = { session, dispose: vi.fn(async () => undefined) };
    manager.registerLiveSessionContext(project, runtime);
    await manager.addProject({ directory: "/repo" });

    const result = await Promise.race([
      manager.abort("pi:s1", "/repo", undefined).then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 20)),
    ]);

    expect(result).toBe("resolved");
    expect(abort).toHaveBeenCalledOnce();
    expect(project.busySessionIds.has("s1")).toBe(false);
    expect(project.abortedSessionIds.has("s1")).toBe(true);
    await expect(manager.getSessionStatuses({ directory: "/repo" })).resolves.toMatchObject({
      "pi:s1": { type: "idle" },
    });
    expect(sent.filter((event) => (event as { type?: string }).type === "pi:event")).toEqual([
      {
        type: "pi:event",
        directory: "/repo",
        workspaceId: undefined,
        payload: {
          type: "session.status",
          sessionID: "s1",
          status: { type: "idle" },
        },
      },
    ]);
  });

  test("treats already-settled Pi sessions as successfully stopped", async () => {
    const manager = new PiBridgeManager(() => []);
    const sent: unknown[] = [];
    manager.sendNativeEvent = (event: unknown) => sent.push(event);
    const project = registerPiBridgeProjectForTests(manager, { directory: "/repo" });
    project.busySessionIds.add("s1");
    const decoySessionManager = {
      getBranch: () => [],
      getSessionId: () => "s2",
      getCwd: () => "/repo",
      getSessionName: () => "s2",
      getHeader: () => ({ timestamp: new Date().toISOString() }),
    };
    manager.registerLiveSessionContext(project, {
      session: {
        sessionId: "s2",
        sessionManager: decoySessionManager as PiSessionManagerLike,
        subscribe: noopSubscribe,
      },
      dispose: vi.fn(async () => undefined),
    });
    await manager.addProject({ directory: "/repo" });

    await manager.abort("pi:s1", "/repo", undefined);

    expect(project.busySessionIds.has("s1")).toBe(false);
    expect(sent.filter((event) => (event as { type?: string }).type === "pi:event")).toEqual([
      {
        type: "pi:event",
        directory: "/repo",
        workspaceId: undefined,
        payload: {
          type: "session.status",
          sessionID: "s1",
          status: { type: "idle" },
        },
      },
    ]);
  });
});
