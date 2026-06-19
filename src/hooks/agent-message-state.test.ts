import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { Message, Part } from "@/protocol/harness-types";
import { getMessageText, limitMessageWindow } from "./agent-message-state";
import type { MessageEntry } from "./agent-state-types";

describe("agent-message-state", () => {
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

  test("limitMessageWindow trims oldest when over cap", () => {
    const messages: MessageEntry[] = Array.from({ length: 1005 }, (_, i) => ({
      info: { id: `m${i}`, sessionID: "s1", role: "user", time: { created: i } } as Message,
      parts: [],
    }));
    const limited = limitMessageWindow(messages);
    expect(limited).toHaveLength(1000);
    expect(limited[0]?.info.id).toBe("m5");
  });
});
