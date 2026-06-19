import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { MessageEntry } from "@/hooks/agent-state-types";
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

  test("older phase prepends only messages missing from live", () => {
    const live = [entry("m2", "assistant", "new", 2)];
    const page = [entry("m1", "user", "old", 1), entry("m2", "assistant", "stale", 2)];
    const merged = mergeTranscriptPageWithLive(live, page, { running: true, phase: "older" });
    expect(merged.map((m) => m.info.id)).toEqual(["m1", "m2"]);
    expect(merged[1]?.parts[0]?.text).toBe("new");
  });
});
