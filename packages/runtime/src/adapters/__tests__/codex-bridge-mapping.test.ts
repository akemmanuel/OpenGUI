import { describe, expect, test } from "vite-plus/test";
import {
  appServerReasoningText,
  buildMessagesFromCodexAppServerThread,
  normalizeAppServerItem,
} from "../codex-bridge-mapping.ts";

describe("codex-bridge-mapping", () => {
  test("normalizeAppServerItem maps reasoning and plan types", () => {
    expect(normalizeAppServerItem({ type: "reasoning", id: "r1", summary: "think" })).toEqual({
      id: "r1",
      type: "reasoning",
      text: "think",
    });
    expect(normalizeAppServerItem({ type: "plan", id: "p1", text: "plan text" })).toEqual({
      id: "p1",
      type: "reasoning",
      text: "plan text",
    });
  });

  test("appServerReasoningText collects nested summary", () => {
    expect(
      appServerReasoningText({
        summary: [{ text: "a" }, { text: "b" }],
      }),
    ).toBe("a\n\nb");
  });

  test("#130 buildMessagesFromCodexAppServerThread emits one reasoning part per reasoning item", () => {
    const messages = buildMessagesFromCodexAppServerThread({
      id: "thread-1",
      cwd: "/repo",
      turns: [
        {
          id: "t1",
          startedAt: 1_700_000_000,
          items: [
            { type: "userMessage", id: "u1", content: [{ text: "Hi" }] },
            { type: "reasoning", id: "r1", text: "ponder" },
            { type: "agentMessage", id: "a1", text: "Done" },
          ],
        },
      ],
    });
    expect(messages).toHaveLength(3);
    const reasoning = messages.find((m) => m.parts.some((p) => p.type === "reasoning"));
    expect(reasoning?.parts.filter((p) => p.type === "reasoning")).toHaveLength(1);
    expect(reasoning?.parts[0]).toMatchObject({ type: "reasoning", text: "ponder" });
  });
});
