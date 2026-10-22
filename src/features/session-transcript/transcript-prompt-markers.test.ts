import { describe, expect, test } from "vite-plus/test";
import { buildPromptMarkers } from "./transcript-prompt-markers";
import type { TranscriptRow } from "./transcript-row-model";

function row(id: string, role: string, ...texts: string[]): TranscriptRow {
  return {
    kind: "message",
    id,
    spacing: "",
    actions: {},
    entry: {
      info: { id, sessionID: "s1", role, time: { created: 1 } },
      parts: texts.map((text, index) => ({ id: `${id}-${index}`, type: "text", text })),
    },
  } as TranscriptRow;
}

describe("buildPromptMarkers", () => {
  test("pairs each prompt with the reply text that followed it", () => {
    const markers = buildPromptMarkers([
      row("u1", "user", "Fix the  login\nbug"),
      row("a1", "assistant", "Done, the session", "cookie is set."),
      row("u2", "user", "Look at @shots/home.png please"),
    ]);
    expect(markers).toEqual([
      { id: "u1", prompt: "Fix the login bug", reply: "Done, the session cookie is set." },
      { id: "u2", prompt: "Look at home.png please", reply: "" },
    ]);
  });

  test("ignores synthetic parts and clips long previews", () => {
    const first = row("u1", "user", "x".repeat(400));
    first.entry.parts.push({ id: "syn", type: "text", text: "hidden", synthetic: true });
    const [marker] = buildPromptMarkers([first]);
    expect(marker?.prompt).toHaveLength(280);
    expect(marker?.prompt.endsWith("…")).toBe(true);
    expect(marker?.prompt).not.toContain("hidden");
  });
});
