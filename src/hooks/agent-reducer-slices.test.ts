import { describe, expect, test } from "vite-plus/test";
import { initialAgentState } from "@/hooks/agent-initial-state";
import { reduceWorkspaceSlice } from "@/hooks/agent-reducer-workspace-slice";
import { reduceSessionActivitySlice } from "@/hooks/agent-reducer-session-activity-slice";

describe("reduceWorkspaceSlice", () => {
  test("SET_DEFAULT_CHAT_DIRECTORY updates directory", () => {
    const next = reduceWorkspaceSlice(initialAgentState, {
      type: "SET_DEFAULT_CHAT_DIRECTORY",
      payload: "/chat",
    });
    expect(next.defaultChatDirectory).toBe("/chat");
  });

  test("SET_BOOT_STATE is handled by session slice, not workspace slice", () => {
    const next = reduceWorkspaceSlice(initialAgentState, {
      type: "SET_BOOT_STATE",
      payload: { state: "ready" },
    });
    expect(next).toBe(initialAgentState);
  });
});

describe("reduceSessionActivitySlice", () => {
  test("SET_BOOT_STATE updates boot fields", () => {
    const next = reduceSessionActivitySlice(initialAgentState, {
      type: "SET_BOOT_STATE",
      payload: { state: "ready", error: null, logs: "ok" },
    });
    expect(next.bootState).toBe("ready");
    expect(next.bootLogs).toBe("ok");
  });

  test("SET_BUSY toggles isBusy", () => {
    const next = reduceSessionActivitySlice(initialAgentState, {
      type: "SET_BUSY",
      payload: true,
    });
    expect(next.isBusy).toBe(true);
  });
});
