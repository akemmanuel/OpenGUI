import { describe, expect, test } from "vite-plus/test";
import {
  asHarnessString,
  asHarnessStringOr,
  getSessionPreview,
  makeReasoningPart,
  makeSessionTitle,
  upsertMessage,
} from "../grok-build-bridge-mapping.ts";

describe("grok-build-bridge-mapping", () => {
  test("asHarnessString narrows unknown without object coercion", () => {
    expect(asHarnessString("id")).toBe("id");
    expect(asHarnessString(42)).toBeUndefined();
    expect(asHarnessString({ sessionId: "x" })).toBeUndefined();
    expect(asHarnessStringOr("a", "b")).toBe("a");
    expect(asHarnessStringOr(undefined, "b")).toBe("b");
  });

  test("makeSessionTitle truncates first line", () => {
    expect(makeSessionTitle("hello\nworld")).toBe("hello");
    expect(makeSessionTitle("   ")).toBe("Untitled");
  });

  test("makeReasoningPart id encodes message and kind", () => {
    expect(makeReasoningPart("grok-build:s", "msg", "msg:reasoning", "think").id).toBe(
      "msg:reasoning",
    );
  });

  test("upsertMessage updates existing bundle", () => {
    const messages: Array<{ info: { id: string; role?: string }; parts: unknown[] }> = [];
    upsertMessage(messages, { id: "m1", role: "user" });
    upsertMessage(messages, { id: "m1", role: "assistant" });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.info.role).toBe("assistant");
  });

  test("getSessionPreview walks user text parts", () => {
    const preview = getSessionPreview([
      {
        info: { role: "assistant" },
        parts: [{ type: "text", text: "no" }],
      },
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "last question" }],
      },
    ]);
    expect(preview).toBe("last question");
  });
});
