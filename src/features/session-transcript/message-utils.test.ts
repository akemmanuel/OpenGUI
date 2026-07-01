import { describe, expect, test } from "vite-plus/test";
import type { Message, Part } from "@/protocol/harness-types";
import { getMessageText } from "@/features/session-transcript/message-utils";
import type { MessageEntry } from "@/hooks/agent-state-types";

describe("message-utils", () => {
  test("getMessageText joins text parts", () => {
    const entry: MessageEntry = {
      info: { id: "m1", sessionID: "s1", role: "assistant", time: { created: 0 } } as Message,
      parts: [
        { id: "p1", type: "text", text: "hello", sessionID: "s1", messageID: "m1" } as Part,
        { id: "p2", type: "text", text: "world", sessionID: "s1", messageID: "m1" } as Part,
      ],
    };
    expect(getMessageText(entry)).toBe("hello\nworld");
  });
});
