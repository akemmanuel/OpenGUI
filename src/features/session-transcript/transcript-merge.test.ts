import { describe, expect, test } from "vite-plus/test";
import type { MessageEntry } from "@/hooks/agent-state-types";
import type { ToolCallState } from "@/protocol/session-transcript";
import { mergeTranscriptPageWithLive } from "@/features/session-transcript/transcript-merge";

function entry(id: string, role: "user" | "assistant", text: string, created = 1): MessageEntry {
  return {
    info: {
      id,
      sessionID: "s1",
      role,
      time: { created },
      providerID: "",
      modelID: "",
    },
    parts: [
      {
        id: `${id}:p`,
        sessionID: "s1",
        messageID: id,
        type: "text",
        text,
        tokens: {},
      },
    ],
  };
}

function toolEntry(id: string, state: ToolCallState): MessageEntry {
  return {
    info: {
      id,
      sessionID: "s1",
      role: "assistant",
      time: { created: 1 },
      providerID: "",
      modelID: "",
    },
    parts: [
      {
        id: `${id}:tool:read-1`,
        sessionID: "s1",
        messageID: id,
        type: "tool",
        callID: "read-1",
        tool: "read",
        tokens: {},
        state,
      },
    ],
  };
}

describe("mergeTranscriptPageWithLive", () => {
  test("final phase accepts page text when it is not older than live", () => {
    const live = [entry("m1", "assistant", "live-long")];
    const page = [entry("m1", "assistant", "authoritative-final")];
    const merged = mergeTranscriptPageWithLive(live, page, { running: true, phase: "final" });
    expect(merged[0]?.parts[0]?.text).toBe("authoritative-final");
  });

  test("final phase does not shorten newer live text with a stale page", () => {
    const live = [entry("m1", "assistant", "streamed complete answer")];
    const page = [entry("m1", "assistant", "streamed")];
    const merged = mergeTranscriptPageWithLive(live, page, { running: false, phase: "final" });
    expect(merged[0]?.parts[0]?.text).toBe("streamed complete answer");
  });

  test("final phase enriches same-id live tool parts from the canonical page", () => {
    const live = [toolEntry("m1", { status: "completed", input: {}, output: undefined })];
    const page = [
      toolEntry("m1", {
        status: "completed",
        input: { path: "package.json" },
        output: '{"name":"opengui"}',
      }),
    ];

    const merged = mergeTranscriptPageWithLive(live, page, { running: false, phase: "final" });

    expect(merged[0]?.parts[0]).toMatchObject({
      type: "tool",
      state: {
        status: "completed",
        input: { path: "package.json" },
        output: '{"name":"opengui"}',
      },
    });
  });

  test("final phase does not delete live-only assistant messages when final page lags", () => {
    const live = [
      entry("u1", "user", "hi", 1),
      entry("live-only-assistant", "assistant", "Hello", 2),
    ];
    const page = [entry("u1", "user", "hi", 1)];

    const merged = mergeTranscriptPageWithLive(live, page, { running: false, phase: "final" });

    expect(merged.map((m) => m.info.id)).toEqual(["u1", "live-only-assistant"]);
  });

  test("final phase keeps live-only messages while still running", () => {
    const live = [entry("live-only-assistant", "assistant", "streaming", 2)];
    const page = [entry("u1", "user", "hi", 1)];

    const merged = mergeTranscriptPageWithLive(live, page, { running: true, phase: "final" });

    expect(merged.map((m) => m.info.id)).toEqual(["u1", "live-only-assistant"]);
  });

  test("older phase prepends only messages missing from live", () => {
    const live = [entry("m2", "assistant", "new", 2)];
    const page = [entry("m1", "user", "old", 1), entry("m2", "assistant", "stale", 2)];
    const merged = mergeTranscriptPageWithLive(live, page, { running: true, phase: "older" });
    expect(merged.map((m) => m.info.id)).toEqual(["m1", "m2"]);
    expect(merged[1]?.parts[0]?.text).toBe("new");
  });

  test("older phase keeps the page the user requested even when current history is large", () => {
    const live = Array.from({ length: 1000 }, (_, i) =>
      entry(`live-${i}`, i % 2 === 0 ? "user" : "assistant", `current ${i}`, i + 100),
    );
    const older = Array.from({ length: 30 }, (_, i) =>
      entry(`older-${i}`, i % 2 === 0 ? "user" : "assistant", `older ${i}`, i),
    );

    const merged = mergeTranscriptPageWithLive(live, older, { running: false, phase: "older" });

    expect(merged).toHaveLength(1030);
    expect(merged.slice(0, 30).map((m) => m.info.id)).toEqual(older.map((m) => m.info.id));
    expect(merged.at(30)?.info.id).toBe("live-0");
  });
});
