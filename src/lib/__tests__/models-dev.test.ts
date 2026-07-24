import { describe, expect, it } from "vite-plus/test";
import { reasoningMetadataForModel } from "../models-dev";

describe("reasoningMetadataForModel", () => {
  it("uses published effort levels supported by the Host", () => {
    const metadata = reasoningMetadataForModel(
      {
        "openai/gpt-5": {
          name: "GPT-5",
          release_date: "2025-08-07",
          reasoning: true,
          reasoning_options: [
            { type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] },
          ],
        },
      },
      "gpt-5",
    );

    expect(metadata.capabilities.reasoning).toBe(true);
    expect(metadata.reasoningEfforts).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(metadata.name).toBe("GPT-5");
  });

  it("hides reasoning for a known non-reasoning model", () => {
    const metadata = reasoningMetadataForModel(
      { "example/plain-model": { reasoning: false } },
      "plain-model",
    );

    expect(metadata.capabilities.reasoning).toBe(false);
    expect(metadata.reasoningEfforts).toBeUndefined();
  });

  it("includes off for models that publish a reasoning toggle", () => {
    const metadata = reasoningMetadataForModel(
      {
        "opencode/deepseek-v4-flash-free": {
          reasoning: true,
          reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["high", "max"] }],
        },
      },
      "deepseek-v4-flash-free",
    );

    expect(metadata.reasoningEfforts).toEqual(["none", "high", "max"]);
  });

  it("keeps unknown custom models configurable", () => {
    const metadata = reasoningMetadataForModel({}, "private-model");

    expect(metadata.capabilities.reasoning).toBe(true);
    expect(metadata.reasoningEfforts).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });
});
