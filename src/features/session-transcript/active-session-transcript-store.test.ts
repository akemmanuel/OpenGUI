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
