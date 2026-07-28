export type ProviderModelRoute = "openai-chat" | "anthropic-messages" | "responses";

export interface ProviderModelCapabilities {
  displayName?: string;
  context?: number;
  reasoning: boolean;
  reasoningEfforts?: readonly string[];
}

export interface ProviderConnectionPreset {
  id: string;
  label: string;
  baseUrl: string;
  defaultModelId: string;
  modelIds: readonly string[];
  modelRoutes?: Readonly<Record<string, ProviderModelRoute>>;
  modelCapabilities?: Readonly<Record<string, ProviderModelCapabilities>>;
}

const codexCapabilities = (
  displayName: string,
  context: number,
  reasoningEfforts: readonly string[],
): ProviderModelCapabilities => ({ displayName, context, reasoning: true, reasoningEfforts });

export const CHATGPT_CODEX_PRESET = {
  id: "chatgpt-codex",
  label: "ChatGPT (Codex)",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  defaultModelId: "gpt-5.6-sol",
  modelIds: [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex-spark",
  ],
  modelRoutes: {
    "gpt-5.6-sol": "responses",
    "gpt-5.6-terra": "responses",
    "gpt-5.6-luna": "responses",
    "gpt-5.5": "responses",
    "gpt-5.4": "responses",
    "gpt-5.4-mini": "responses",
    "gpt-5.3-codex-spark": "responses",
  },
  modelCapabilities: {
    "gpt-5.6-sol": codexCapabilities("GPT-5.6-Sol", 372_000, [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]),
    "gpt-5.6-terra": codexCapabilities("GPT-5.6-Terra", 372_000, [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]),
    "gpt-5.6-luna": codexCapabilities("GPT-5.6-Luna", 372_000, [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]),
    "gpt-5.5": codexCapabilities("GPT-5.5", 272_000, ["low", "medium", "high", "xhigh"]),
    "gpt-5.4": codexCapabilities("GPT-5.4", 272_000, ["low", "medium", "high", "xhigh"]),
    "gpt-5.4-mini": codexCapabilities("GPT-5.4-Mini", 272_000, ["low", "medium", "high", "xhigh"]),
    // Spark is a plan-gated preview and is absent from the public source catalog,
    // so only its documented reasoning capability is asserted here.
    "gpt-5.3-codex-spark": { reasoning: true },
  },
} as const satisfies ProviderConnectionPreset;

export const SUPERGROK_PRESET = {
  id: "supergrok",
  label: "SuperGrok (experimental OAuth)",
  baseUrl: "https://cli-chat-proxy.grok.com/v1",
  defaultModelId: "grok-build",
  modelIds: ["grok-build"],
  modelRoutes: { "grok-build": "responses" },
  modelCapabilities: {
    "grok-build": {
      displayName: "Grok Build",
      context: 256_000,
      reasoning: true,
    },
  },
} as const satisfies ProviderConnectionPreset;

/** Public, documented xAI API surface. This is deliberately not the subscription proxy. */
export const XAI_API_PRESET = {
  id: "xai-api",
  label: "xAI API",
  baseUrl: "https://api.x.ai/v1",
  defaultModelId: "grok-build-0.1",
  modelIds: ["grok-build-0.1", "grok-code-fast-1", "grok-code-fast", "grok-code-fast-1-0825"],
  modelRoutes: {
    "grok-build-0.1": "responses",
    "grok-code-fast-1": "responses",
    "grok-code-fast": "responses",
    "grok-code-fast-1-0825": "responses",
  },
  modelCapabilities: Object.fromEntries(
    ["grok-build-0.1", "grok-code-fast-1", "grok-code-fast", "grok-code-fast-1-0825"].map(
      (modelId) => [
        modelId,
        {
          displayName: modelId === "grok-build-0.1" ? "Grok Build 0.1" : modelId,
          context: 256_000,
          reasoning: true,
        },
      ],
    ),
  ),
} as const satisfies ProviderConnectionPreset;

export const OPENCODE_GO_PRESET = {
  id: "opencode-go",
  label: "OpenCode Go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  defaultModelId: "glm-5.2",
  modelIds: [
    "glm-5.2",
    "glm-5.1",
    "kimi-k2.7-code",
    "kimi-k2.6",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "minimax-m3",
    "minimax-m2.7",
    "minimax-m2.5",
    "qwen3.7-max",
    "qwen3.7-plus",
    "qwen3.6-plus",
  ],
  modelRoutes: {
    "glm-5.2": "openai-chat",
    "glm-5.1": "openai-chat",
    "kimi-k2.7-code": "openai-chat",
    "kimi-k2.6": "openai-chat",
    "mimo-v2.5": "openai-chat",
    "mimo-v2.5-pro": "openai-chat",
    "deepseek-v4-pro": "openai-chat",
    "deepseek-v4-flash": "openai-chat",
    "minimax-m3": "anthropic-messages",
    "minimax-m2.7": "anthropic-messages",
    "minimax-m2.5": "anthropic-messages",
    "qwen3.7-max": "anthropic-messages",
    "qwen3.7-plus": "anthropic-messages",
    "qwen3.6-plus": "anthropic-messages",
  },
} as const satisfies ProviderConnectionPreset;

export function supportedOpenCodeGoModelIds(discoveredIds: readonly string[]) {
  const available = new Set(discoveredIds);
  return OPENCODE_GO_PRESET.modelIds.filter((modelId) => available.has(modelId));
}
