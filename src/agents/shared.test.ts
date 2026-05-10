import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { Session } from "@opencode-ai/sdk/v2/client";
import type { NativeBackendEvent } from "@/types/electron";
import { normalizeTaggedBackendEvent } from "./shared";

const session = {
  id: "raw-session",
  title: "Raw session",
  directory: "/repo",
} as unknown as Session;

describe("normalizeTaggedBackendEvent", () => {
  test("normalizes connection status events", () => {
    const event = {
      type: "connection:status",
      directory: "/repo",
      workspaceId: "workspace-1",
      payload: {
        state: "connected",
        serverUrl: null,
        serverVersion: null,
        error: null,
        lastEventAt: null,
      },
    } as unknown as NativeBackendEvent;

    expect(normalizeTaggedBackendEvent("codex", event, "codex:event")).toEqual({
      type: "connection.status",
      directory: "/repo",
      workspaceId: "workspace-1",
      status: {
        state: "connected",
        serverUrl: null,
        serverVersion: null,
        error: null,
        lastEventAt: null,
      },
    });
  });

  test("tags session lifecycle payloads", () => {
    const event = {
      type: "pi:event",
      payload: {
        type: "session.created",
        directory: "/repo",
        workspaceId: "workspace-1",
        session,
      },
    } as unknown as NativeBackendEvent;

    const normalized = normalizeTaggedBackendEvent("pi", event, "pi:event");

    expect(normalized).toMatchObject({
      type: "session.created",
      directory: "/repo",
      workspaceId: "workspace-1",
      session: {
        id: "pi:raw-session",
        _rawId: "raw-session",
        _backendId: "pi",
        _projectDir: "/repo",
        _workspaceId: "workspace-1",
      },
    });
  });

  test("prefixes ids in non-session payloads", () => {
    const event = {
      type: "claude-code:event",
      payload: {
        type: "message.part.delta",
        sessionID: "raw-session",
        messageID: "message-1",
        partID: "part-1",
        field: "text",
        delta: "hello",
      },
    } as unknown as NativeBackendEvent;

    expect(normalizeTaggedBackendEvent("claude-code", event, "claude-code:event")).toEqual({
      type: "message.part.delta",
      sessionID: "claude-code:raw-session",
      messageID: "message-1",
      partID: "part-1",
      field: "text",
      delta: "hello",
    });
  });

  test("ignores unrelated native event channels", () => {
    const event = {
      type: "pi:event",
      payload: { type: "session.deleted", sessionId: "raw-session", directory: "/repo" },
    } as unknown as NativeBackendEvent;

    expect(normalizeTaggedBackendEvent("codex", event, "codex:event")).toBeNull();
  });
});
