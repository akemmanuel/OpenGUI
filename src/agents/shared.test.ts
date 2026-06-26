import { describe, expect, test } from "vite-plus/test";
import type { Session } from "@opencode-ai/sdk/v2/client";
import type { NativeBackendEvent } from "@/types/electron";
import { normalizeTaggedHarnessEvent } from "./shared";

const session = {
  id: "raw-session",
  title: "Raw session",
  directory: "/repo",
} as unknown as Session;

describe("normalizeTaggedHarnessEvent", () => {
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

    expect(normalizeTaggedHarnessEvent("codex", event, "codex:event")).toEqual({
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

    const normalized = normalizeTaggedHarnessEvent("pi", event, "pi:event");

    expect(normalized).toMatchObject({
      type: "session.created",
      directory: "/repo",
      workspaceId: "workspace-1",
      session: {
        id: "pi:raw-session",
        _rawId: "raw-session",
        _harnessId: "pi",
        _projectDir: "/repo",
        _workspaceId: "workspace-1",
      },
    });
  });

  test("keeps a session-owned directory when it differs from the event target", () => {
    const event = {
      type: "opencode:event",
      payload: {
        type: "session.created",
        directory: "/pictures",
        workspaceId: "workspace-1",
        session: { ...session, directory: "/documents" },
      },
    } as unknown as NativeBackendEvent;

    const normalized = normalizeTaggedHarnessEvent("opencode", event, "opencode:event");

    expect(normalized).toMatchObject({
      type: "session.created",
      session: {
        _projectDir: "/documents",
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

    expect(normalizeTaggedHarnessEvent("claude-code", event, "claude-code:event")).toEqual({
      type: "message.part.delta",
      sessionID: "claude-code:raw-session",
      messageID: "message-1",
      partID: "part-1",
      field: "text",
      delta: "hello",
    });
  });

  test("prefixes session error ids", () => {
    const event = {
      type: "pi:event",
      payload: {
        type: "session.error",
        sessionID: "raw-session",
        error: "Claude auth expired",
      },
    } as unknown as NativeBackendEvent;

    expect(normalizeTaggedHarnessEvent("pi", event, "pi:event")).toEqual({
      type: "session.error",
      sessionID: "pi:raw-session",
      error: "Claude auth expired",
    });
  });

  test("ignores unrelated native event channels", () => {
    const event = {
      type: "pi:event",
      payload: { type: "session.deleted", sessionId: "raw-session", directory: "/repo" },
    } as unknown as NativeBackendEvent;

    expect(normalizeTaggedHarnessEvent("codex", event, "codex:event")).toBeNull();
  });
});
