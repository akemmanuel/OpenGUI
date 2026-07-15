import { describe, expect, test } from "vite-plus/test";
import { ActiveSessionTranscriptStore } from "./active-session-transcript-store";

describe("ActiveSessionTranscriptStore derived snapshots", () => {
  test("returns stable references until the store changes", () => {
    const store = new ActiveSessionTranscriptStore();

    expect(store.getHistorySnapshot()).toBe(store.getHistorySnapshot());
    expect(store.getPromptHistory()).toBe(store.getPromptHistory());
    expect(store.getCompactionTailMessages()).toBe(store.getCompactionTailMessages());
  });
});
