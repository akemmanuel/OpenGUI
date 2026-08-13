import { describe, expect, it, vi } from "vite-plus/test";
import { connectionsToModelProviders, reasoningMetadataForModel } from "../models-dev";

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

  it("uses the canonical vendor entry instead of unioning reseller capabilities", () => {
    const metadata = reasoningMetadataForModel(
      {
        "deepseek/deepseek-v4-pro": {
          reasoning: true,
          reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["high", "max"] }],
        },
        "reseller/deepseek-v4-pro": {
          reasoning: true,
          reasoning_options: [
            { type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] },
          ],
        },
      },
      "deepseek-v4-pro",
      { baseUrl: "https://api.deepseek.com" },
    );

    expect(metadata.reasoningEfforts).toEqual(["none", "high", "max"]);
  });

  it("uses a conservative toggle-shaped default for unknown custom models", () => {
    const metadata = reasoningMetadataForModel({}, "private-model");

    expect(metadata.capabilities.reasoning).toBe(true);
    expect(metadata.reasoningEfforts).toEqual(["none", "high"]);
  });
});

describe("connectionsToModelProviders", () => {
  it("keeps catalog reasoning efforts when a custom connection has no explicit override", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          deepseek: {
            models: {
              "deepseek-v4-pro": {
                reasoning: true,
                reasoning_options: [
                  { type: "toggle" },
                  { type: "effort", values: ["high", "max"] },
                ],
              },
            },
          },
        }),
      }),
    );

    const [provider] = await connectionsToModelProviders([
      {
        id: "deepseek-custom",
        label: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        modelIds: ["deepseek-v4-pro"],
        modelCapabilities: {
          "deepseek-v4-pro": { reasoning: true, reasoningEfforts: [] },
        },
      },
    ]);

    expect(provider?.models["deepseek-v4-pro"]?.reasoningEfforts).toEqual(["none", "high", "max"]);
    vi.unstubAllGlobals();
  });
});
