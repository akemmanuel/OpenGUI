import { describe, expect, test } from "vite-plus/test";
import type { TranscriptPart } from "@/protocol/session-transcript";
import { groupToolsUntilAssistantText } from "./MessagePartsStack";

function part(id: string, type: "reasoning" | "text" | "tool"): TranscriptPart {
  if (type === "reasoning") return { id, type, text: id, time: {}, sessionID: "s", messageID: "m" };
  if (type === "text") return { id, type, text: id, sessionID: "s", messageID: "m" };
  return {
    id,
    type,
    tool: "read",
    state: { status: "completed", input: {}, output: "" },
    sessionID: "s",
    messageID: "m",
  };
}

describe("groupToolsUntilAssistantText", () => {
  test("reasoning does not split a tool group, while assistant text does", () => {
    const grouped = groupToolsUntilAssistantText([
      part("read-1", "tool"),
      part("thought-1", "reasoning"),
      part("shell-1", "tool"),
      part("answer", "text"),
      part("edit-1", "tool"),
    ]);

    expect(
      grouped.map((item) => (Array.isArray(item) ? item.map((entry) => entry.id) : item.id)),
    ).toEqual([["read-1", "thought-1", "shell-1"], "answer", ["edit-1"]]);
  });
});
