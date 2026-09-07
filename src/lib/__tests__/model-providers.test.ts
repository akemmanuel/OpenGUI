import { expect, test, vi } from "vite-plus/test";
import { connectionsToModelProviders } from "../model-providers";

test("renders Host metadata without fetching a second catalog", () => {
  const fetchImpl = vi.fn();
  vi.stubGlobal("fetch", fetchImpl);
  try {
    const [provider] = connectionsToModelProviders([
      {
        id: "codex",
        label: "Codex",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        modelIds: ["gpt-6-astra", "private", "plain"],
        modelCapabilities: {
          "gpt-6-astra": {
            displayName: "GPT-6 Astra",
            context: 272000,
            reasoning: true,
            reasoningEfforts: ["high", "max"],
          },
          plain: { reasoning: false },
        },
      },
    ]);
    expect(provider?.models["gpt-6-astra"]).toMatchObject({
      name: "GPT-6 Astra",
      limit: { context: 272000 },
      reasoningEfforts: ["high", "max"],
    });
    expect(provider?.models.private?.reasoningEfforts).toEqual(["none", "high"]);
    expect(provider?.models.plain?.reasoningEfforts).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
