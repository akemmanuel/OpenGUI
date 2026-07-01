import { describe, expect, test } from "vite-plus/test";
import type { MessageEntry } from "@/hooks/agent-state-types";
import {
  resolveActiveTranscriptLoading,
  resolveMessageListChrome,
} from "./message-list-viewport-state";

function msg(id: string, role: "user" | "assistant" = "user"): MessageEntry {
  return {
    info: { id, role, time: { created: 1 } },
    parts: [{ type: "text", text: "hi" }],
  } as MessageEntry;
}

describe("resolveActiveTranscriptLoading", () => {
  test("true when scope matches and phase is loading", () => {
    expect(
      resolveActiveTranscriptLoading(
        {
          scope: { sessionId: "s1", directory: "/r" },
          phase: "loading",
        } as Parameters<typeof resolveActiveTranscriptLoading>[0],
        "s1",
      ),
    ).toBe(true);
  });

  test("false when session differs", () => {
    expect(
      resolveActiveTranscriptLoading(
        {
          scope: { sessionId: "s1", directory: "/r" },
          phase: "loading",
        } as Parameters<typeof resolveActiveTranscriptLoading>[0],
        "s2",
      ),
    ).toBe(false);
  });
});

describe("resolveMessageListChrome", () => {
  test("empty idle session shows empty viewport", () => {
    const chrome = resolveMessageListChrome({
      messages: [],
      sessionMetaForActive: undefined,
      revertMessageID: undefined,
      isBusy: false,
      isLoadingMessages: false,
      activeSessionId: "s1",
      activeLoadError: null,
      activeLoadErrorText: null,
    });
    expect(chrome.viewport).toEqual({ kind: "empty" });
    expect(chrome.visibleMessageCount).toBe(0);
  });

  test("with messages shows transcript viewport", () => {
    const chrome = resolveMessageListChrome({
      messages: [msg("m1")],
      sessionMetaForActive: undefined,
      revertMessageID: undefined,
      isBusy: false,
      isLoadingMessages: false,
      activeSessionId: "s1",
      activeLoadError: null,
      activeLoadErrorText: null,
    });
    expect(chrome.viewport).toEqual({ kind: "transcript" });
    expect(chrome.visibleMessageCount).toBe(1);
  });
});
