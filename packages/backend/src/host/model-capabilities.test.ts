import { describe, expect, test } from "vite-plus/test";
import { resolveConnectionReasoningEfforts } from "./model-capabilities.ts";

describe("resolveConnectionReasoningEfforts", () => {
  test("prefers canonical first-party metadata over divergent reseller metadata", () => {
    expect(
      resolveConnectionReasoningEfforts(
        {
          id: "deepseek-custom",
          label: "DeepSeek",
          baseUrl: "https://api.deepseek.com",
          modelIds: ["deepseek-v4-pro"],
          modelCapabilities: { "deepseek-v4-pro": { reasoning: true } },
        },
        "deepseek-v4-pro",
        {
          "reseller/deepseek-v4-pro": {
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["low", "medium", "xhigh"] }],
          },
          "deepseek/deepseek-v4-pro": {
            reasoning: true,
            reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["high", "max"] }],
          },
        },
      ),
    ).toEqual(["none", "high", "max"]);
  });

  test("keeps explicit preset efforts and uses a conservative unknown default", () => {
    expect(
      resolveConnectionReasoningEfforts(
        {
          id: "preset",
          label: "Preset",
          baseUrl: "https://example.com",
          modelIds: ["known"],
          modelCapabilities: {
            known: { reasoning: true, reasoningEfforts: ["low", "high", "xhigh"] },
          },
        },
        "known",
        null,
      ),
    ).toEqual(["low", "high", "xhigh"]);

    expect(
      resolveConnectionReasoningEfforts(
        {
          id: "private",
          label: "Private",
          baseUrl: "https://example.com",
          modelIds: ["private-model"],
          modelCapabilities: { "private-model": { reasoning: true } },
        },
        "private-model",
        null,
      ),
    ).toEqual(["none", "high"]);
  });
});
