import { describe, expect, test } from "vite-plus/test";
import type { MessageEntry } from "@/hooks/agent-state-types";
import { buildTurnFooterByMessageId } from "./turn-footers";

function message(
  id: string,
  role: "user" | "assistant",
  created: number,
  completed?: number,
): MessageEntry {
  return {
    info: {
      id,
      sessionID: "session-1",
      role,
      providerID: role === "assistant" ? "openai" : "",
      modelID: role === "assistant" ? "gpt-5" : "",
      time: { created, completed },
    },
    parts: [],
  } as MessageEntry;
}

describe("buildTurnFooterByMessageId", () => {
  test("marks only the active assistant turn as running", () => {
    const footers = buildTurnFooterByMessageId(
      [
        message("user-1", "user", 1_000),
        message("assistant-1", "assistant", 1_500, 3_000),
        message("user-2", "user", 4_000),
        message("assistant-2", "assistant", 4_500),
      ],
      true,
    );

    expect(footers.get("assistant-1")).toMatchObject({
      startedAt: 1_000,
      completedAt: 3_000,
      running: false,
    });
    expect(footers.get("assistant-2")).toMatchObject({
      startedAt: 4_000,
      running: true,
    });
  });

  test("does not restart an old footer while waiting for the next assistant message", () => {
    const footers = buildTurnFooterByMessageId(
      [
        message("user-1", "user", 1_000),
        message("assistant-1", "assistant", 1_500, 3_000),
        message("user-2", "user", 4_000),
      ],
      true,
    );

    expect(footers.get("assistant-1")?.running).toBe(false);
  });
});
