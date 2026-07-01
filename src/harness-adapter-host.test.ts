import { describe, expect, test } from "vite-plus/test";
import {
  makeHarnessBridgeEventEmitter,
  makeHarnessBridgeEventSender,
  registerHarnessRpcHandlers,
  registerObjectTargetHarnessRpcHandlers,
} from "../packages/runtime/src/adapters/harness-adapter-host.ts";

describe("harness adapter host", () => {
  test("registerHarnessRpcHandlers wraps successful handler results", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
    registerHarnessRpcHandlers(
      "test-harness",
      {
        handle(channel, handler) {
          handlers.set(channel, handler);
        },
      },
      {
        add: (left: unknown, right: unknown) => Number(left) + Number(right),
      },
    );

    await expect(handlers.get("test-harness:add")?.({}, 2, 3)).resolves.toEqual({
      success: true,
      data: 5,
    });
  });

  test("registerHarnessRpcHandlers wraps thrown errors", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
    registerHarnessRpcHandlers(
      "test-harness",
      {
        handle(channel, handler) {
          handlers.set(channel, handler);
        },
      },
      {
        fail: () => {
          throw new Error("boom");
        },
      },
    );

    await expect(handlers.get("test-harness:fail")?.({})).resolves.toEqual({
      success: false,
      error: "boom",
      data: undefined,
    });
  });

  test("makeHarnessBridgeEventEmitter broadcasts to live windows only", () => {
    const sent: unknown[] = [];
    const emit = makeHarnessBridgeEventEmitter("test-harness", () => [
      {
        isDestroyed: () => false,
        webContents: { send: (channel: string, event: unknown) => sent.push([channel, event]) },
      },
      {
        isDestroyed: () => true,
        webContents: { send: (channel: string, event: unknown) => sent.push([channel, event]) },
      },
    ]);

    emit({ type: "connection:status" });

    expect(sent).toEqual([["test-harness:bridge-event", { type: "connection:status" }]]);
  });

  test("makeHarnessBridgeEventSender sends to one live sender", () => {
    const sent: unknown[] = [];
    const send = makeHarnessBridgeEventSender("test-harness");

    send(
      {
        isDestroyed: () => false,
        send: (channel: string, event: unknown) => sent.push([channel, event]),
      },
      { type: "connection:status" },
    );

    send(
      {
        isDestroyed: () => true,
        send: (channel: string, event: unknown) => sent.push([channel, event]),
      },
      { type: "connection:status" },
    );

    expect(sent).toEqual([["test-harness:bridge-event", { type: "connection:status" }]]);
  });

  test("registerObjectTargetHarnessRpcHandlers routes through current manager", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
    const calls: unknown[] = [];
    let manager = {
      addProject: (config: unknown) => calls.push(["old:add", config]),
      removeProject: (target: unknown) => calls.push(["old:remove", target]),
      disconnect: () => calls.push(["old:disconnect"]),
      listSessions: (target: unknown) => ["old:list", target],
      createSession: (input: unknown) => ["old:create", input],
      deleteSession: (sessionId: unknown, target: unknown) => ["old:delete", sessionId, target],
      updateSession: (sessionId: unknown, title: unknown, target: unknown) => [
        "old:update",
        sessionId,
        title,
        target,
      ],
      getSessionStatuses: (target: unknown) => ["old:statuses", target],
      getProviders: () => ["old:providers"],
      getAgents: () => ["old:agents"],
      getCommands: () => ["old:commands"],
      getMessages: (sessionId: unknown, target: unknown) => ["old:messages", sessionId, target],
      startSession: (input: unknown) => ["old:start", input],
      prompt: (...args: unknown[]) => calls.push(["old:prompt", args]),
      abort: (sessionId: unknown) => ["old:abort", sessionId],
      sendCommand: (...args: unknown[]) => calls.push(["old:command", args]),
      summarizeSession: (...args: unknown[]) => calls.push(["old:summarize", args]),
    };
    registerObjectTargetHarnessRpcHandlers(
      "test-harness",
      {
        handle(channel, handler) {
          handlers.set(channel, handler);
        },
      },
      () => manager,
    );
    manager = { ...manager, listSessions: (target: unknown) => ["new:list", target] };

    await expect(handlers.get("test-harness:session:list")?.({}, "/repo", "ws")).resolves.toEqual({
      success: true,
      data: ["new:list", { directory: "/repo", workspaceId: "ws" }],
    });
  });
});
