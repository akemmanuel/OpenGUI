import { describe, expect, test } from "vite-plus/test";
import { piAiCatalogConnection, piAiFreeModelIds, piAiTextOnlyModelIds } from "./pi-ai-catalog.ts";

describe("pi-ai provider catalogs", () => {
  test("adapts the canonical Codex catalog", () => {
    const connection = piAiCatalogConnection("openai-codex", {
      id: "chatgpt-codex",
      label: "ChatGPT (Codex)",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });

    expect(connection.modelIds).toContain("gpt-5.5");
    expect(connection.modelRoutes?.["gpt-5.5"]).toBe("responses");
    expect(connection.modelCapabilities?.["gpt-5.5"]).toMatchObject({
      displayName: "GPT-5.5",
      context: 272_000,
      reasoning: true,
    });
    expect(connection.modelCapabilities?.["gpt-5.5"]?.reasoningEfforts).toContain("xhigh");
  });

  test("preserves OpenCode Go's per-model protocols", () => {
    const connection = piAiCatalogConnection("opencode-go", {
      id: "opencode-go",
      label: "OpenCode Go",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });

    expect(connection.modelRoutes?.["minimax-m3"]).toBe("anthropic-messages");
    expect(connection.modelRoutes?.["glm-5.2"]).toBe("openai-chat");
    expect(connection.modelRoutes?.["grok-4.6"]).toBe("responses");
  });

  test("derives Zen's free models from pi-ai pricing metadata", () => {
    const free = piAiFreeModelIds("opencode");
    expect(free).toContain("big-pickle");
    expect(free).toContain("mimo-v2.6-flash-free");
    expect(free).not.toContain("deepseek-v4-pro");
  });

  test("derives text-only behavior from pi-ai input metadata", () => {
    const textOnly = piAiTextOnlyModelIds("opencode");
    expect(textOnly).toContain("deepseek-v4-flash");
    expect(textOnly).not.toContain("mimo-v2.6-flash-free");
  });
});
