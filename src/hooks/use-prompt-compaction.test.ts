import { describe, expect, test } from "vite-plus/test";
import { isCompactionTurnInProgress } from "@/hooks/use-prompt-compaction";
import type { MessageEntry } from "@/hooks/agent-state-types";

function message(role: "user" | "assistant", extra: Record<string, unknown> = {}): MessageEntry {
  return {
    info: {
      id: `${role}-${Math.random()}`,
      sessionID: "session-1",
      role,
      time: { created: 1 },
      ...extra,
    },
    parts: [],
  } as unknown as MessageEntry;
}

describe("isCompactionTurnInProgress", () => {
  test("detects a running compaction turn", () => {
    expect(
      isCompactionTurnInProgress({
        isLoading: true,
        messages: [message("assistant", { summary: true }), message("user")],
      }),
    ).toBe(true);
  });

  test("requires loading", () => {
    expect(
      isCompactionTurnInProgress({
        isLoading: false,
        messages: [message("assistant", { summary: true }), message("user")],
      }),
    ).toBe(false);
  });

  test("requires the previous assistant message to be a summary", () => {
    expect(
      isCompactionTurnInProgress({
        isLoading: true,
        messages: [message("assistant"), message("user")],
      }),
    ).toBe(false);
  });
});
