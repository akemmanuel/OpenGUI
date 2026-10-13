import { expect, test, vi } from "vite-plus/test";
import { offeringsToModelConnections, connectionsToModelProviders } from "../model-providers";

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

test("preserves supported reasoning levels through the offering picker projection", () => {
  const reasoningEfforts = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
  const [provider] = connectionsToModelProviders(
    offeringsToModelConnections([
      {
        id: "sol",
        displayName: "Sol",
        description: null,
        createdAt: 1,
        updatedAt: 1,
        modelCapabilities: {
          reasoning: true,
          reasoningEfforts: [...reasoningEfforts],
          context: 272000,
        },
      },
    ]),
  );
  expect(provider?.models.sol?.reasoningEfforts).toEqual(reasoningEfforts);
  expect(provider?.models.sol?.limit).toEqual({ context: 272000 });
  expect(offeringsToModelConnections([])).toEqual([]);
});
