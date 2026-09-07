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
  defaultModelId?: string;
  modelIds: readonly string[];
  modelRoutes?: Readonly<Record<string, ProviderModelRoute>>;
  modelCapabilities?: Readonly<Record<string, ProviderModelCapabilities>>;
}

export const CHATGPT_CODEX_PRESET = {
  id: "chatgpt-codex",
  label: "ChatGPT (Codex)",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  defaultModelId: "gpt-5.6-sol",
  // The Host overlays pi's remote catalog on bundled pi-ai metadata.
  modelIds: [],
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

export const OPENCODE_ZEN_PRESET = {
  id: "opencode-zen",
  label: "OpenCode Zen",
  baseUrl: "https://opencode.ai/zen/v1",
  // The Host filters pi's catalog to free models when no API key is configured.
  modelIds: [],
} as const satisfies ProviderConnectionPreset;

export const OPENCODE_GO_PRESET = {
  id: "opencode-go",
  label: "OpenCode Go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  defaultModelId: "glm-5.2",
  // The Host overlays pi's remote catalog on bundled pi-ai metadata.
  modelIds: [],
} as const satisfies ProviderConnectionPreset;
