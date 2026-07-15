import { describe, expect, test } from "vite-plus/test";
import {
  buildTranscriptRows,
  messageBubbleSpacingClass,
} from "@/features/session-transcript/transcript-row-model";
import type { MessageEntry } from "@/hooks/agent-state-types";

function entry(id: string, role: "user" | "assistant"): MessageEntry {
  return {
    info: {
      id,
      sessionID: "s1",
      role,
      time: { created: 1 },
      providerID: "",
      modelID: "",
    },
    parts: [
      { id: `${id}:p`, sessionID: "s1", messageID: id, type: "text", text: "hi", tokens: {} },
    ],
  };
}

describe("messageBubbleSpacingClass", () => {
  test("first row has no margin class", () => {
    expect(messageBubbleSpacingClass(0, entry("u1", "user"), null)).toBe("");
  });

  test("same role consecutive uses tight spacing", () => {
    expect(messageBubbleSpacingClass(1, entry("u2", "user"), "user")).toBe("mt-1");
  });

  test("role change uses loose spacing", () => {
    expect(messageBubbleSpacingClass(1, entry("a1", "assistant"), "user")).toBe("mt-4");
  });
});

describe("buildTranscriptRows", () => {
  test("omits fork on first user message", () => {
    const rows = buildTranscriptRows({
      visibleMessages: [entry("u1", "user"), entry("a1", "assistant")],
      turnFooterByMessageId: new Map(),
      firstUserMessageIndex: 0,
      capabilities: { fork: true, revert: true },
      forkFromMessage: () => {},
      revertToMessage: () => {},
    });
    const firstUser = rows.find((r) => r.entry.info.id === "u1");
    expect(firstUser?.actions.onFork).toBeUndefined();
    expect(firstUser?.actions.onRevert).toBeDefined();
  });

  test("keeps live reasoning in the preceding assistant tool activity row", () => {
    const toolMessage = entry("a1", "assistant");
    toolMessage.parts = [
      {
        id: "tool-1",
        sessionID: "s1",
        messageID: "a1",
        type: "tool",
        tool: "shell",
        state: { status: "completed", input: {}, output: "" },
        tokens: {},
      },
    ];
    const reasoningMessage = entry("a2", "assistant");
    reasoningMessage.parts = [
      {
        id: "reasoning-1",
        sessionID: "s1",
        messageID: "a2",
        type: "reasoning",
        text: "Still working",
        time: { start: 2 },
        tokens: {},
      },
    ];

    const rows = buildTranscriptRows({
      visibleMessages: [entry("u1", "user"), toolMessage, reasoningMessage],
      turnFooterByMessageId: new Map(),
      firstUserMessageIndex: 0,
      capabilities: null,
      forkFromMessage: () => {},
      revertToMessage: () => {},
    });

    expect(rows).toHaveLength(2);
    expect(rows[1]?.entry.parts.map((part) => part.id)).toEqual(["tool-1", "reasoning-1"]);
  });
});
