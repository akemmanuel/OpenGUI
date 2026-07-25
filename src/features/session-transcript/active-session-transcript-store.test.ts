import { describe, expect, test } from "vite-plus/test";
import { ActiveSessionTranscriptStore } from "./active-session-transcript-store";
import type { MessageEntry } from "@/hooks/agent-state-types";

describe("ActiveSessionTranscriptStore derived snapshots", () => {
  test("returns stable references until the store changes", () => {
    const store = new ActiveSessionTranscriptStore();

    expect(store.getHistorySnapshot()).toBe(store.getHistorySnapshot());
    expect(store.getPromptHistory()).toBe(store.getPromptHistory());
    expect(store.getCompactionTailMessages()).toBe(store.getCompactionTailMessages());
  });

  test("keeps visible history but resets context-meter messages at completed compaction", () => {
    const store = new ActiveSessionTranscriptStore();
    const scope = { directory: "/project", sessionId: "session-1" };
    const message = (
      id: string,
      role: "user" | "assistant",
      parts: MessageEntry["parts"],
    ): MessageEntry => ({
      info: {
        id,
        sessionID: scope.sessionId,
        role,
        providerID: "openai",
        modelID: "gpt-5",
        time: { created: 1_000 },
      },
      parts,
    });
    const oldMessage = message("old", "user", [
      {
        id: "old:text",
        type: "text",
        text: "old context",
        sessionID: scope.sessionId,
        messageID: "old",
        tokens: {},
      },
    ]);
    const compaction = message("compact", "assistant", [
      {
        id: "compact:part",
        type: "compaction",
        sessionID: scope.sessionId,
        messageID: "compact",
        tokens: {},
        metadata: { status: "completed", reason: "manual" },
      },
    ]);
    const newMessage = message("new", "user", [
      {
        id: "new:text",
        type: "text",
        text: "continue",
        sessionID: scope.sessionId,
        messageID: "new",
        tokens: {},
      },
    ]);

    store.select(scope);
    store.dispatch({
      type: "snapshot.loaded",
      scope,
      messages: [oldMessage, compaction, newMessage],
      hasMore: false,
      nextCursor: null,
    });

    expect(store.getSnapshot().messages).toEqual([oldMessage, compaction, newMessage]);
    expect(store.getContextMessages()).toEqual([newMessage]);
  });

  test("shows an accepted local message before the Host stream catches up", () => {
    const store = new ActiveSessionTranscriptStore();
    const scope = { directory: "/project", sessionId: "session-1" };
    const message: MessageEntry = {
      info: {
        id: "optimistic:message-1",
        sessionID: scope.sessionId,
        role: "user",
        providerID: "openai",
        modelID: "gpt-5",
        time: { created: 1_000 },
      },
      parts: [],
    };

    store.select(scope);
    store.dispatch({ type: "message.appended", scope, message });

    expect(store.getSnapshot().messages).toEqual([message]);
  });
});
