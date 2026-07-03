import { describe, expect, test, vi } from "vite-plus/test";
import { PiBridgeManager } from "../pi-bridge.ts";
import type {
  PiLiveSessionLike,
  PiNativeSessionEvent,
  PiSessionManagerLike,
} from "../pi-bridge-types.ts";
import {
  handlePiToolExecutionStart,
  resolvePiToolAssistantBundle,
} from "../pi-bridge-session-events.ts";
import { createAssistantInfo, createBundle } from "../pi-bridge-mapping.ts";
import { registerPiBridgeProjectForTests } from "../pi-project-slot.ts";

function noopSubscribe() {
  return () => undefined;
}

describe("pi-bridge-session-events", () => {
  test("handlePiToolExecutionStart attaches tool to resolved assistant bundle", () => {
    const sessionId = "s1";
    const real = createBundle(
      createAssistantInfo({ sessionId, messageId: "real", timestamp: 1, createdAt: 100 }),
      [],
    );
    const project = { sessionCaches: new Map([[sessionId, { messages: [real] }]]) };
    const state = {
      currentAssistantMessageId: "syn",
      syntheticToReal: new Map([["syn", "real"]]),
    };
    const upsertBundle = vi.fn();
    const sendBackendEvent = vi.fn();
    const ctx = {
      upsertBundle,
      sendBackendEvent,
      findBundle: () => null,
      findCurrentAssistantBundle: (p: typeof project, sid: string, st: typeof state) =>
        resolvePiToolAssistantBundle(p, sid, st),
      flushPendingAssistantResolution: () => undefined,
      findLatestRealMessageId: () => "",
      markReasoningStart: () => undefined,
      markReasoningEnd: () => undefined,
      closeOpenReasoning: () => undefined,
    };
    handlePiToolExecutionStart(ctx, project, sessionId, state, {
      toolCallId: "tc1",
      toolName: "read",
      args: { path: "a.ts" },
    });
    expect(upsertBundle).toHaveBeenCalled();
    expect(sendBackendEvent).toHaveBeenCalledWith(
      project,
      expect.objectContaining({ type: "message.part.updated" }),
    );
    const bundle = upsertBundle.mock.calls[0]?.[2] as { parts: { callID?: string }[] };
    expect(bundle.parts.some((p) => p.callID === "tc1")).toBe(true);
  });

  test("replaces the temporary streaming assistant with the canonical Pi message", async () => {
    const manager = new PiBridgeManager(() => []);
    const sent: unknown[] = [];
    manager.sendNativeEvent = (event: unknown) => sent.push(event);
    const project = registerPiBridgeProjectForTests(manager, { directory: "/repo" });
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
