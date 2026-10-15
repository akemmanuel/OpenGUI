import { describe, expect, test } from "vite-plus/test";
import {
  createPiModels,
  ISOLATED_AUTH_CONTEXT,
  piAiCatalogConnection,
  piBundledModels,
  piProviderDescriptors,
} from "./pi-ai-catalog.ts";

describe("pi-ai provider catalogs", () => {
  test("adapts the canonical Codex catalog", () => {
    const connection = piAiCatalogConnection("openai-codex", {
      id: "chatgpt-codex",
      label: "ChatGPT (Codex)",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });

    expect(connection.modelIds).toContain("gpt-5.5");
    expect(connection.modelCapabilities?.["gpt-5.5"]).toMatchObject({
      displayName: "GPT-5.5",
      context: 272_000,
      reasoning: true,
    });
    expect(connection.modelCapabilities?.["gpt-5.5"]?.reasoningEfforts).toContain("xhigh");
  });

  test("lists every pi chat provider with its sign-in methods", () => {
    const providers = piProviderDescriptors();
    const ids = providers.map((provider) => provider.id);
    for (const id of ["anthropic", "openai", "google", "amazon-bedrock", "mistral", "xai"]) {
      expect(ids).toContain(id);
    }
    expect(ids).toContain("opencode");
    expect(ids).toContain("opencode-go");
    // Classifier-only providers have nothing to chat with.
    expect(ids).not.toContain("typesafe");
    expect(providers.find((provider) => provider.id === "openai-codex")).toMatchObject({
      oauth: { subscription: true },
    });
    expect(providers.find((provider) => provider.id === "openai-codex")?.apiKey).toBeUndefined();
    expect(providers.find((provider) => provider.id === "anthropic")).toMatchObject({
      apiKey: { interactive: true },
      oauth: { subscription: true },
    });
  });

  test("keeps installed models for every chat API pi supports", () => {
    expect(piBundledModels("google")[0]?.api).toBe("google-generative-ai");
    expect(piBundledModels("amazon-bedrock")[0]?.api).toBe("bedrock-converse-stream");
    expect(piBundledModels("mistral")[0]?.api).toBe("mistral-conversations");
  });

  test("resolves stored API keys and never ambient credentials in an isolated scope", async () => {
    const stored = new Map<string, any>([["groq", { type: "api_key", key: "gsk-stored" }]]);
    const models = createPiModels({
      authContext: ISOLATED_AUTH_CONTEXT,
      credentials: {
        read: async (providerId) => stored.get(providerId),
        list: async () => [],
        modify: async (providerId, change) => {
          const next = await change(stored.get(providerId));
          if (next) stored.set(providerId, next);
          return next ?? stored.get(providerId);
        },
        delete: async (providerId) => void stored.delete(providerId),
      },
    });
    expect((await models.getAuth("groq"))?.auth.apiKey).toBe("gsk-stored");
    process.env.ANTHROPIC_API_KEY ??= "sk-ant-ambient";
    expect(await models.getAuth("anthropic")).toBeUndefined();
  });
});
