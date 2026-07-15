import { describe, expect, test } from "vite-plus/test";
import { chatDeltaEvents } from "./openai-chat.ts";

describe("chatDeltaEvents", () => {
  test("projects interleaved reasoning_content separately from answer text", () => {
    expect(chatDeltaEvents({ reasoning_content: "Check the factors." })).toEqual([
      { type: "reasoning_delta", delta: "Check the factors." },
    ]);
    expect(chatDeltaEvents({ content: "The answer is 42." })).toEqual([
      { type: "text_delta", delta: "The answer is 42." },
    ]);
  });
});
