import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { MessageEntry } from "@/hooks/use-agent-state";
import {
  findLastUserMessageBeforeRevert,
  getRevertCutIndex,
  isBeforeRevertPoint,
} from "./message-revert";
import {
  buildVisibleMessages,
  countRevertedVisibleMessages,
  hasVisibleContent,
} from "./visible-transcript";

function msg(
  id: string,
  role: "user" | "assistant",
  parts: MessageEntry["parts"] = [],
): MessageEntry {
  return {
    info: {
      id,
      sessionID: "s1",
      role,
      time: { created: 0 },
      providerID: "",
      modelID: "",
    },
    parts,
  };
}

describe("message-revert", () => {
  const messages = [
    msg("a", "user"),
    msg("b", "assistant"),
    msg("c", "user"),
    msg("d", "assistant"),
  ];

  test("getRevertCutIndex uses transcript order not string sort", () => {
    expect(getRevertCutIndex(messages, "c")).toBe(2);
    expect(getRevertCutIndex(messages, "missing")).toBeNull();
  });

  test("isBeforeRevertPoint compares indices", () => {
    expect(isBeforeRevertPoint(messages, "b", "c")).toBe(true);
    expect(isBeforeRevertPoint(messages, "d", "c")).toBe(false);
  });

  test("findLastUserMessageBeforeRevert", () => {
    expect(findLastUserMessageBeforeRevert(messages, undefined)?.info.id).toBe("c");
    expect(findLastUserMessageBeforeRevert(messages, "c")?.info.id).toBe("a");
  });
});

describe("visible-transcript", () => {
  test("hasVisibleContent hides whitespace-only text", () => {
    expect(
      hasVisibleContent(
        msg("u", "user", [
          { id: "p1", sessionID: "s1", messageID: "u", type: "text", text: "   ", tokens: {} },
        ]),
      ),
    ).toBe(false);
  });

  test("buildVisibleMessages applies revert by order", () => {
    const messages = [msg("z-last", "user"), msg("a-first", "assistant"), msg("m-mid", "user")];
    const visible = buildVisibleMessages(messages, { revertMessageID: "m-mid" });
    expect(visible.map((m) => m.info.id)).toEqual(["z-last", "a-first"]);
  });

  test("countRevertedVisibleMessages", () => {
    const messages = [msg("1", "user"), msg("2", "assistant"), msg("3", "user")];
    expect(countRevertedVisibleMessages(messages, "2")).toBe(2);
  });
});
