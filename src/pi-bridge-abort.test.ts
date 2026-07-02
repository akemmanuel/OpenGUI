import { describe, expect, test, vi } from "vite-plus/test";
import { PiBridgeManager } from "../packages/runtime/src/adapters/pi-bridge.ts";
import type {
  PiLiveSessionLike,
  PiNativeSessionEvent,
  PiSessionManagerLike,
} from "../packages/runtime/src/adapters/pi-bridge-types.ts";

function noopSubscribe() {
  return () => undefined;
}

function createRegisteredProject(manager: PiBridgeManager) {
  const project = manager.getListProject({ directory: "/repo" });
  project.runtime = null;
  (manager as unknown as { projects: Map<string, typeof project> }).projects.set(
    project.key,
    project,
  );
  manager.resolveProjectForSession = async () => project;
  return project;
}

describe("PiBridgeManager abort", () => {
  test("signals active Pi sessions without waiting for Pi settle listeners", async () => {
    const manager = new PiBridgeManager(() => []);
    const sent: unknown[] = [];
    manager.sendNativeEvent = (event: unknown) => sent.push(event);
    const project = createRegisteredProject(manager);
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
    project.liveSessionContexts.set("s1", { runtime, session, unsubscribe: null });

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
    const project = createRegisteredProject(manager);
    project.busySessionIds.add("s1");

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

  test("replaces the temporary streaming assistant with the canonical Pi message", async () => {
    const manager = new PiBridgeManager(() => []);
    const sent: unknown[] = [];
    manager.sendNativeEvent = (event: unknown) => sent.push(event);
    const project = createRegisteredProject(manager);
    const branch: Array<{ message: unknown } & Record<string, unknown>> = [];
    const sessionManager = {
      getSessionId: () => "s1",
      getBranch: () => branch,
      getCwd: () => "/repo",
      getSessionName: () => "s1",
      getHeader: () => ({ timestamp: new Date().toISOString() }),
    };
    const session: PiLiveSessionLike = {
      sessionId: "s1",
      sessionManager: sessionManager as PiSessionManagerLike,
      subscribe: noopSubscribe,
    };
    project.sessionCaches.set("s1", { messages: [] });
    const eventAt = 1_700_000_000_000;

    await manager.handleSessionEvent(project, session, {
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        provider: "pi",
        model: "model",
        stopReason: "stop",
        timestamp: eventAt,
      },
    });
    const liveState = project.liveStateBySessionId.get("s1");
    if (liveState?.pendingAssistantResolutions?.[0]) {
      liveState.pendingAssistantResolutions[0].startedAt = eventAt;
    }
    await manager.handleSessionEvent(project, session, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0 },
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        provider: "pi",
        model: "model",
        usage: {},
        stopReason: "stop",
        timestamp: eventAt,
      },
    });

    branch.push({
      type: "message",
      id: "a1",
      parentId: null,
      timestamp: new Date(eventAt + 5).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        provider: "pi",
        model: "model",
        usage: {},
        stopReason: "stop",
        timestamp: eventAt,
      },
    });
    await manager.handleSessionEvent(project, session, {
      type: "turn_end",
      message: branch[0]!.message as PiNativeSessionEvent["message"] & { role: string },
      toolResults: [],
    });

    const bridgeEvents = sent
      .filter((event) => (event as { type?: string }).type === "pi:event")
      .map((event) => (event as { payload: unknown }).payload as Record<string, unknown>);
    const streamingUpdate = bridgeEvents.find((event) => {
      const msg = event.message as { id?: string } | undefined;
      return event.type === "message.updated" && msg?.id?.startsWith("pi:stream:");
    });
    const replacement = bridgeEvents.find((event) => event.type === "message.replaced");
    expect(streamingUpdate).toBeTruthy();
    expect(replacement).toMatchObject({
      type: "message.replaced",
      sessionID: "pi:s1",
      oldId: (streamingUpdate?.message as { id?: string } | undefined)?.id,
      message: { id: "a1", sessionID: "pi:s1", role: "assistant" },
    });
  });
});
