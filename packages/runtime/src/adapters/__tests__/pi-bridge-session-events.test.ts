import { describe, expect, test, vi } from "vite-plus/test";
import {
  handlePiToolExecutionStart,
  resolvePiToolAssistantBundle,
} from "../pi-bridge-session-events.ts";
import { createAssistantInfo, createBundle } from "../pi-bridge-mapping.ts";

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
});
