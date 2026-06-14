import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { Event as OpenCodeEvent, Message, Session } from "@opencode-ai/sdk/v2/client";
import { mapOpenCodeEvent } from "./opencode-map";

const context = { directory: "/repo", workspaceId: "workspace-1" };

describe("mapOpenCodeEvent", () => {
  test("tags session lifecycle events with OpenCode metadata", () => {
    const session = { id: "session-1", title: "Work", directory: "/repo" } as unknown as Session;

    expect(
      mapOpenCodeEvent(
        {
          type: "session.created",
          properties: { info: session },
        } as unknown as OpenCodeEvent,
        context,
      ),
    ).toMatchObject({
      type: "session.created",
      directory: "/repo",
      workspaceId: "workspace-1",
      session: {
        id: "opencode:session-1",
        _rawId: "session-1",
        _harnessId: "opencode",
        _projectDir: "/repo",
        _workspaceId: "workspace-1",
      },
    });
  });

  test("normalizes message IDs", () => {
    const message = { id: "message-1", sessionID: "session-1" } as unknown as Message;

    expect(
      mapOpenCodeEvent(
        {
          type: "message.updated",
          properties: { info: message },
        } as unknown as OpenCodeEvent,
        context,
      ),
    ).toEqual({
      type: "message.updated",
      message: { id: "message-1", sessionID: "opencode:session-1" },
    });
  });

  test("maps sync envelopes after stripping numeric type suffixes", () => {
    expect(
      mapOpenCodeEvent(
        {
          type: "sync",
          syncEvent: {
            id: "event-1",
            type: "message.part.delta.0",
            data: {
              sessionID: "session-1",
              messageID: "message-1",
              partID: "part-1",
              field: "text",
              delta: "hello",
            },
          },
        },
        context,
      ),
    ).toEqual({
      id: "event-1",
      type: "message.part.delta",
      sessionID: "opencode:session-1",
      messageID: "message-1",
      partID: "part-1",
      field: "text",
      delta: "hello",
    });
  });

  test("maps sync question replies", () => {
    expect(
      mapOpenCodeEvent(
        {
          type: "sync",
          syncEvent: {
            id: "event-2",
            type: "question.replied.0",
            data: {
              sessionID: "session-1",
              requestID: "question-1",
              answers: [["Yes"]],
            },
          },
        },
        context,
      ),
    ).toEqual({
      type: "question.cleared",
      sessionID: "opencode:session-1",
    });
  });

  test("maps v2 permission requests to panel-compatible shape", () => {
    expect(
      mapOpenCodeEvent(
        {
          type: "permission.v2.asked",
          properties: {
            id: "permission-1",
            sessionID: "session-1",
            action: "external_directory",
            resources: ["/tmp/opengui-uploads/*"],
            save: ["/tmp/opengui-uploads/*"],
            metadata: { tool: "read" },
          },
        } as unknown as OpenCodeEvent,
        context,
      ),
    ).toEqual({
      type: "permission.requested",
      request: {
        id: "permission-1",
        sessionID: "opencode:session-1",
        permission: "external_directory",
        patterns: ["/tmp/opengui-uploads/*"],
        always: ["/tmp/opengui-uploads/*"],
        metadata: { tool: "read" },
        source: undefined,
      },
    });
  });

  test("maps v2 permission replies", () => {
    expect(
      mapOpenCodeEvent(
        {
          type: "permission.v2.replied",
          properties: {
            sessionID: "session-1",
            requestID: "permission-1",
            reply: "once",
          },
        } as unknown as OpenCodeEvent,
        context,
      ),
    ).toEqual({
      type: "permission.cleared",
      sessionID: "opencode:session-1",
    });
  });

  test("returns null for unhandled and aborted error events", () => {
    expect(
      mapOpenCodeEvent(
        { type: "unknown.event", properties: {} } as unknown as OpenCodeEvent,
        context,
      ),
    ).toBeNull();

    expect(
      mapOpenCodeEvent(
        {
          type: "session.error",
          properties: { sessionID: "session-1", error: { name: "MessageAbortedError" } },
        } as unknown as OpenCodeEvent,
        context,
      ),
    ).toBeNull();
  });
});
