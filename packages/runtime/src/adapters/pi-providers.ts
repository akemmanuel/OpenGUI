import { findEnvKeys, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";

const PROVIDER_ENVS: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  gemini: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  xai: ["XAI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  moonshot: ["MOONSHOT_API_KEY"],
  ollama: [],
  lmstudio: [],
  bedrock: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
  azure: ["AZURE_OPENAI_API_KEY"],
};

export type PiProviderModel = {
  id: string;
  provider: string;
  input?: string[];
  reasoning?: unknown;
  api?: string;
  baseUrl?: string;
  name?: string;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
};

type ProviderData = {
  id: string;
  name: string;
  source: string;
  env: string[];
  options: Record<string, unknown>;
  models: Record<string, ReturnType<typeof normalizePiModel>>;
};

type ModelRegistry = {
  refresh?: () => void;
  getAll: () => PiProviderModel[];
  authStorage: {
    get?: (providerId: string) => { type?: string } | undefined;
    hasAuth?: (providerId: string) => boolean;
  };
  getProviderDisplayName?: (providerId: string) => string | undefined;
  getProviderAuthStatus?: (providerId: string) => { configured?: boolean; source?: string };
};

function normalizePiModel(model: PiProviderModel) {
  const input = Array.isArray(model?.input) ? model.input : [];
  const supportedVariants = model?.reasoning ? getSupportedThinkingLevels(model as Model<Api>) : [];
  const variants = supportedVariants.length
    ? Object.fromEntries(supportedVariants.map((variant) => [variant, { label: variant }]))
    : undefined;
  return {
    id: model.id,
    providerID: model.provider,
    api: {
      id: String(model.api || model.provider),
      url: model.baseUrl || "",
      npm: "@earendil-works/pi-coding-agent",
    },
    name: model.name || model.id,
    family: model.id,
    capabilities: {
      temperature: true,
      reasoning: Boolean(model.reasoning),
      attachment: input.includes("image"),
      toolcall: true,
      input: { text: true, audio: false, image: input.includes("image"), video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: {
      input: model.cost?.input ?? 0,
      output: model.cost?.output ?? 0,
      cache: { read: model.cost?.cacheRead ?? 0, write: model.cost?.cacheWrite ?? 0 },
    },
    limit: { context: model.contextWindow ?? 0, output: model.maxTokens ?? 0 },
    status: "active",
    options: {},
    headers: model.headers ?? {},
    release_date: "",
    variants,
  };
}

export function buildProvidersData(models: PiProviderModel[]) {
  const providers = new Map<string, ProviderData>();
  const defaults: Record<string, string> = {};
  for (const model of models) {
    const providerId = model.provider;
    const normalizedModel = normalizePiModel(model);
    if (!providers.has(providerId)) {
      providers.set(providerId, {
        id: providerId,
        name: providerId,
        source: "api",
        env: PROVIDER_ENVS[providerId] ?? [],
        options: {},
        models: {},
      });
    }
    providers.get(providerId)!.models[normalizedModel.id] = normalizedModel;
    if (!defaults[providerId]) defaults[providerId] = normalizedModel.id;
  }
  return { providers: Array.from(providers.values()), default: defaults };
}

export function buildAllProvidersData(modelRegistry: ModelRegistry) {
  modelRegistry.refresh?.();
  const { providers, default: defaults } = buildProvidersData(modelRegistry.getAll());
  const authStorage = modelRegistry.authStorage;
  const connected: string[] = [];
  const authKindByProvider: Record<string, string> = {};
  for (const provider of providers) {
    provider.name =
      modelRegistry.getProviderDisplayName?.(provider.id) || provider.name || provider.id;
    const authStatus = modelRegistry.getProviderAuthStatus?.(provider.id) || { configured: false };
    const storedAuth = authStorage.get?.(provider.id);
    if (authStorage.hasAuth?.(provider.id)) connected.push(provider.id);
    if (authStatus?.source === "environment") {
      provider.source = "env";
      authKindByProvider[provider.id] = "env";
    } else if (authStatus?.source === "fallback") {
      provider.source = "custom";
      authKindByProvider[provider.id] = "custom";
    } else if (storedAuth?.type === "oauth") {
      provider.source = "subscription";
      authKindByProvider[provider.id] = "subscription";
    } else if (storedAuth?.type === "api_key" || authStatus?.source === "stored") {
      provider.source = "api";
      authKindByProvider[provider.id] = "api";
    } else if (
      authStatus?.source === "models_json_key" ||
      authStatus?.source === "models_json_command"
    ) {
      provider.source = "custom";
      authKindByProvider[provider.id] = "custom";
    } else {
      provider.source = "config";
      authKindByProvider[provider.id] = "config";
    }
    provider.env = findEnvKeys(provider.id) ?? provider.env ?? [];
  }
  return { all: providers, default: defaults, connected, authKindByProvider };
}
