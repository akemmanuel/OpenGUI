import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { Message, Part } from "@/protocol/harness-types";
import type { MessageEntry } from "@/hooks/agent-state-types";
import { mergeMessageSnapshot } from "./agent-message-state";

function textPart(id: string, messageID: string, text: string, start = 1): Part {
  return {
    id,
    type: "text",
    text,
    sessionID: "session-1",
    messageID,
    time: { start },
  } as Part;
}

function message(id: string, created: number, parts: Part[]): MessageEntry {
  return {
    info: {
      id,
      sessionID: "session-1",
      role: "assistant",
      time: { created },
    } as Message,
    parts,
  };
}

describe("mergeMessageSnapshot", () => {
  test("empty stale snapshot does not wipe existing live messages", () => {
    const existing = [message("live", 10, [textPart("p1", "live", "streaming")])];

    const merged = mergeMessageSnapshot([], existing);

    expect(merged).toEqual(existing);
  });

  test("preserves existing parts missing from stale same-message snapshot", () => {
    const existing = [
      message("assistant", 10, [
        textPart("text", "assistant", "hello", 1),
        textPart("tool", "assistant", "tool output", 2),
      ]),
    ];
    const incoming = [message("assistant", 10, [textPart("text", "assistant", "hello", 1)])];

    const merged = mergeMessageSnapshot(incoming, existing);

    expect(merged[0]?.parts.map((part) => part.id)).toEqual(["text", "tool"]);
  });

  test("keeps existing messages newer than snapshot tail", () => {
    const existing = [
      message("old", 1, [textPart("old-part", "old", "old")]),
      message("new-live", 20, [textPart("new-part", "new-live", "new")]),
    ];
    const incoming = [message("old", 1, [textPart("old-part", "old", "old from server")])];

    const merged = mergeMessageSnapshot(incoming, existing);

    expect(merged.map((entry) => entry.info.id)).toEqual(["old", "new-live"]);
  });

  test("preserves older loaded messages when replacing with a paged snapshot", () => {
    const existing = [
      message("original-user", 1, [textPart("original-part", "original-user", "first prompt")]),
      message("older-assistant", 2, [textPart("older-part", "older-assistant", "early reply")]),
      message("recent-assistant", 10, [textPart("recent-part", "recent-assistant", "recent")]),
    ];
    const incoming = [
      message("recent-assistant", 10, [textPart("recent-part", "recent-assistant", "updated")]),
    ];

    const merged = mergeMessageSnapshot(incoming, existing, {
      preserveExistingBeforeIncoming: true,
    });

    expect(merged.map((entry) => entry.info.id)).toEqual([
      "original-user",
      "older-assistant",
      "recent-assistant",
    ]);
    expect((merged[2]?.parts[0] as Record<string, unknown>)?.text).toBe("updated");
  });

  test("full snapshots can still replace older messages", () => {
    const existing = [
      message("stale-old", 1, [textPart("stale-part", "stale-old", "stale")]),
      message("fresh", 10, [textPart("fresh-part", "fresh", "fresh")]),
    ];
    const incoming = [message("fresh", 10, [textPart("fresh-part", "fresh", "fresh")])];

    const merged = mergeMessageSnapshot(incoming, existing);

    expect(merged.map((entry) => entry.info.id)).toEqual(["fresh"]);
  });
});
