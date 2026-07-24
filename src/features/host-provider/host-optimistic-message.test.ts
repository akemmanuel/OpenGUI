import { describe, expect, test } from "vite-plus/test";
import { createOptimisticUserMessage } from "./host-optimistic-message";

describe("createOptimisticUserMessage", () => {
  test("stamps the presentation-only optimistic message with the current actor snapshot", () => {
    const message = createOptimisticUserMessage({
      id: "optimistic:1",
      sessionId: "session-1",
      text: "Ship it",
      actor: { type: "user", id: "user-1", displayName: "alice" },
      providerId: "openai",
      modelId: "gpt-4.1",
      createdAt: 42,
    });

    expect(message.info.actor).toEqual({
      type: "user",
      id: "user-1",
      displayName: "alice",
    });
    expect(message.parts[0]).toMatchObject({ type: "text", text: "Ship it" });
  });
});
