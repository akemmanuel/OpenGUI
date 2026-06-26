import { describe, expect, test } from "vite-plus/test";
import { buildTranscriptRows } from "@/features/session-transcript/transcript-row-model";
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
});
