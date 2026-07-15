import { describe, expect, test } from "vite-plus/test";
import { codexResponseEvents } from "./codex-responses.ts";

describe("codexResponseEvents", () => {
  test("projects streamed reasoning summaries", () => {
    expect(
      codexResponseEvents({
        type: "response.reasoning_summary_text.delta",
        delta: "I should inspect the project.",
      }),
    ).toEqual([{ type: "reasoning_delta", delta: "I should inspect the project." }]);
    expect(
      codexResponseEvents({
        type: "response.reasoning_summary.delta",
        delta: "Then calculate.",
      }),
    ).toEqual([{ type: "reasoning_delta", delta: "Then calculate." }]);
  });

  test("projects a reasoning summary delivered only on the completed item", () => {
    expect(
      codexResponseEvents({
        type: "response.output_item.done",
        item: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "I multiplied the values." }],
        },
      }),
    ).toEqual([{ type: "reasoning_delta", delta: "I multiplied the values." }]);
  });
});
