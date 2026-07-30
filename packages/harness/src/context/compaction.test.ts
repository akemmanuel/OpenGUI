import { describe, expect, test } from "vite-plus/test";
import { estimateContextTokens } from "./compaction.ts";

describe("estimateContextTokens", () => {
  test("does not count persisted image bytes as text tokens", () => {
    const base64 = "a".repeat(400_000);
    const tokens = estimateContextTokens(
      [
        {
          type: "tool_result",
          toolCallId: "image",
          name: "read",
          output: {
            content: "Read image file [image/png]",
            attachments: [{ type: "image", mimeType: "image/png", data: base64 }],
          },
        },
      ],
      "system",
    );

    expect(tokens).toBeLessThan(1_000);
  });
});
