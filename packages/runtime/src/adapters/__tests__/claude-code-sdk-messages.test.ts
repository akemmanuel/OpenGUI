import { describe, expect, test } from "vite-plus/test";
import {
  isToolResultBlock,
  isToolUseBlock,
  parseClaudeSdkMessage,
} from "../claude-code-sdk-messages.ts";

describe("claude-code-sdk-messages", () => {
  describe("parseClaudeSdkMessage", () => {
    test("returns null without string type field", () => {
      expect(parseClaudeSdkMessage(null)).toBeNull();
      expect(parseClaudeSdkMessage({})).toBeNull();
      expect(parseClaudeSdkMessage({ type: 1 })).toBeNull();
      expect(parseClaudeSdkMessage([])).toBeNull();
    });

    test("returns message record when type is string", () => {
      const raw = {
        type: "assistant",
        subtype: "message",
        message: { id: "m1", content: [{ type: "text", text: "hi" }] },
      };
      expect(parseClaudeSdkMessage(raw)).toEqual(raw);
    });
  });

  describe("tool blocks", () => {
    test("isToolUseBlock requires tool_use type and non-empty id", () => {
      expect(
        isToolUseBlock({ type: "tool_use", id: "tu-1", name: "read", input: { path: "/" } }),
      ).toBe(true);
      expect(isToolUseBlock({ type: "tool_use", id: "" })).toBe(false);
      expect(isToolUseBlock({ type: "text", id: "x" })).toBe(false);
      expect(isToolUseBlock(null)).toBe(false);
    });

    test("isToolResultBlock matches tool_result type", () => {
      expect(
        isToolResultBlock({
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "ok",
          is_error: false,
        }),
      ).toBe(true);
      expect(isToolResultBlock({ type: "tool_use", id: "x" })).toBe(false);
    });
  });
});
