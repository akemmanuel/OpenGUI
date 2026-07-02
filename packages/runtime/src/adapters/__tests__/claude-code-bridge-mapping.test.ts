import { describe, expect, test } from "vite-plus/test";
import {
  makeReasoningPart,
  makeSessionFromInfo,
  mapClaudeModelId,
  tagMessageEntrySession,
} from "../claude-code-bridge-mapping.ts";

describe("claude-code-bridge-mapping", () => {
  test("mapClaudeModelId normalizes sonnet/opus", () => {
    expect(mapClaudeModelId("claude-sonnet-4")).toBe("default");
    expect(mapClaudeModelId("claude-opus-4")).toBe("opus");
  });

  test("makeSessionFromInfo prefixes session id", () => {
    const s = makeSessionFromInfo({ sessionId: "abc", cwd: "/r" }, { workspaceId: "w" });
    expect(s.id).toBe("claude-code:abc");
    expect(s._harnessId).toBe("claude-code");
  });

  test("#130 makeReasoningPart uses stable id per index", () => {
    expect(makeReasoningPart("claude-code:s", "m1", 0, "a").id).toBe("m1:reasoning:0");
    expect(makeReasoningPart("claude-code:s", "m1", 1, "b").id).toBe("m1:reasoning:1");
  });

  test("tagMessageEntrySession rewrites session ids on parts", () => {
    const tagged = tagMessageEntrySession({
      info: { sessionID: "raw" },
      parts: [{ sessionID: "raw", type: "text" }],
    });
    expect(tagged.info.sessionID).toBe("claude-code:raw");
    expect(tagged.parts[0]?.sessionID).toBe("claude-code:raw");
  });
});
