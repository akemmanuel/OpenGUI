// @vitest-environment happy-dom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { useChatSessionSurface } from "./useChatSessionSurface";

afterEach(cleanup);

describe("useChatSessionSurface", () => {
  test("keeps a detached active Session readable without offering a prompt for a disconnected Project", () => {
    const { result } = renderHook(() =>
      useChatSessionSurface({
        sessions: [{ id: "s1", title: "Detached", cwd: "/removed" }] as never,
        activeSessionId: "s1",
        activeTargetDirectory: "/removed",
        sessionMeta: {},
        connections: {
          "/removed": { state: "disconnected" },
          "/live": { state: "connected" },
        } as never,
        defaultChatDirectory: null,
      }),
    );
    expect(result.current.activeSession?.id).toBe("s1");
    expect(result.current.activeSessionDirectory).toBe("/removed");
    expect(result.current.chatSurfaceState).toEqual({ kind: "session", sessionId: "s1" });
    expect(result.current.hasConnectedProjects).toBe(true);
    expect(result.current.showPromptBox).toBe(true);
  });

  test("rejects a stale disconnected new-chat target but permits the default chat directory", () => {
    const input = {
      sessions: [],
      activeSessionId: null,
      sessionMeta: {},
      connections: {} as never,
      defaultChatDirectory: "/home",
    };
    const { result, rerender } = renderHook(
      ({ target }) => useChatSessionSurface({ ...input, activeTargetDirectory: target }),
      { initialProps: { target: "/gone" as string | null } },
    );
    expect(result.current.chatSurfaceState).toEqual({ kind: "default-chat", directory: "/home" });
    expect(result.current.showPromptBox).toBe(false);
    rerender({ target: "/home" });
    expect(result.current.chatSurfaceState).toEqual({ kind: "project", directory: "/home" });
    expect(result.current.showPromptBox).toBe(true);
  });
});
