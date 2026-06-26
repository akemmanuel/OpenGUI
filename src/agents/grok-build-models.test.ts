import { describe, expect, test } from "vite-plus/test";
import {
  buildGrokProvidersFromModelState,
  DEFAULT_MODEL_ID,
  mapGrokModelEntry,
  resolveSelectedModelId,
} from "../../packages/runtime/src/adapters/grok-build-models.ts";

describe("grok-build-models", () => {
  test("maps model entries from ACP model state", () => {
    expect(
      mapGrokModelEntry({
        modelId: "grok-build",
        name: "Grok Build",
        description: "xAI coding model",
      }),
    ).toMatchObject({
      id: "grok-build",
      name: "Grok Build",
      capabilities: { reasoning: true },
    });
  });

  test("builds providers from initialize model state", () => {
    const providers = buildGrokProvidersFromModelState({
      currentModelId: "grok-build",
      availableModels: [
        { modelId: "grok-build", name: "Grok Build", _meta: { agentType: "grok-build-plan" } },
        {
          modelId: "grok-composer-2.5-fast",
          name: "Grok Composer 2.5 Fast",
          _meta: { agentType: "cursor" },
        },
      ],
    });
    expect(providers.default.xai).toBe("grok-build");
    expect(Object.keys(providers.providers[0]!.models)).toEqual([
      "grok-build",
      "grok-composer-2.5-fast",
    ]);
    const models = providers.providers[0]!.models as Record<
      string,
      { capabilities: { reasoning: boolean } }
    >;
    expect(models["grok-build"]!.capabilities.reasoning).toBe(true);
    expect(models["grok-composer-2.5-fast"]!.capabilities.reasoning).toBe(false);
  });

  test("falls back to default model when state is empty", () => {
    const providers = buildGrokProvidersFromModelState(null);
    expect(providers.default.xai).toBe(DEFAULT_MODEL_ID);
  });

  test("resolves selected model ids", () => {
    expect(resolveSelectedModelId({ modelID: "grok-build" })).toBe("grok-build");
    expect(resolveSelectedModelId(null)).toBe(DEFAULT_MODEL_ID);
  });
});
