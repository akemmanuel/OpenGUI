export const MODEL_DISCOVERY_TTL_MS = 5 * 60 * 1000;
export const EFFORT_VARIANTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export type ClaudeSupportedModel = {
  value: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
};

export const FALLBACK_SUPPORTED_MODELS: ClaudeSupportedModel[] = [
  {
    value: "default",
    displayName: "Sonnet",
    description: "Sonnet",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "max"],
    supportsAdaptiveThinking: true,
  },
  {
    value: "opus",
    displayName: "Opus",
    description: "Opus",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
  },
  { value: "haiku", displayName: "Haiku", description: "Haiku" },
];

function makeModel(
  id: string,
  name: string,
  opts: {
    reasoning: boolean;
    image: boolean;
    family?: string;
    variants?: Record<string, Record<string, never>>;
  },
) {
  const { reasoning, image, family, variants } = opts;
  return {
    id,
    providerID: "anthropic",
    api: { id, url: "https://api.anthropic.com", npm: "./claude-agent-sdk-lite/dist/index.js" },
    name,
    family: family ?? id,
    capabilities: {
      temperature: true,
      reasoning,
      attachment: image,
      toolcall: true,
      input: { text: true, audio: false, image, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200_000, output: 8_192 },
    status: "active" as const,
    options: {},
    headers: {},
    release_date: "",
    ...(variants ? { variants } : {}),
  };
}

function firstDescriptionClause(description: unknown): string {
  if (typeof description !== "string") return "";
  return description.split("·", 1)[0]?.trim() ?? "";
}

export function deriveModelName(model: ClaudeSupportedModel | null | undefined): string {
  const headline = firstDescriptionClause(model?.description);
  if (headline) return headline;
  if (model?.value === "default") return "Sonnet";
  if (typeof model?.displayName === "string" && model.displayName.trim())
    return model.displayName.trim();
  return typeof model?.value === "string" && model.value.trim() ? model.value.trim() : "Claude";
}

export function deriveModelFamily(model: ClaudeSupportedModel | null | undefined): string {
  const source = `${deriveModelName(model)} ${model?.displayName ?? ""}`.toLowerCase();
  if (source.includes("opus")) return "opus";
  if (source.includes("haiku")) return "haiku";
  if (source.includes("sonnet") || model?.value === "default") return "sonnet";
  return typeof model?.value === "string" && model.value.trim()
    ? model.value.trim().toLowerCase()
    : "claude";
}

function buildModelVariants(
  model: ClaudeSupportedModel,
): Record<string, Record<string, never>> | undefined {
  const variants: Record<string, Record<string, never>> = {};
  const supportsReasoning =
    Boolean(model.supportsAdaptiveThinking) ||
    Boolean(model.supportsEffort) ||
    Array.isArray(model.supportedEffortLevels);
  if (!supportsReasoning) return undefined;
  variants.none = {};
  for (const level of model.supportedEffortLevels ?? []) {
    if (EFFORT_VARIANTS.has(level)) variants[level] = {};
  }
  return Object.keys(variants).length > 0 ? variants : undefined;
}

export function buildProvidersFromSupportedModels(
  models: ClaudeSupportedModel[] | null | undefined,
) {
  const normalizedModels =
    Array.isArray(models) && models.length > 0 ? models : FALLBACK_SUPPORTED_MODELS;
  const providerModels = Object.fromEntries(
    normalizedModels.map((model) => {
      const reasoning =
        Boolean(model.supportsAdaptiveThinking) ||
        Boolean(model.supportsEffort) ||
        Array.isArray(model.supportedEffortLevels);
      return [
        model.value,
        makeModel(model.value, deriveModelName(model), {
          reasoning,
          image: false,
          family: deriveModelFamily(model),
          variants: buildModelVariants(model),
        }),
      ];
    }),
  );
  const defaultModel =
    normalizedModels.find((model) => model.value === "default")?.value ??
    normalizedModels[0]?.value ??
    "default";
  return {
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        source: "api",
        env: ["ANTHROPIC_API_KEY"],
        options: {},
        models: providerModels,
      },
    ],
    default: { anthropic: defaultModel },
  };
}

export function buildVariantQueryOptions(
  variant: unknown,
  modelInfo: ClaudeSupportedModel | null | undefined,
): Record<string, unknown> {
  const normalized = typeof variant === "string" ? variant.trim().toLowerCase() : "";
  if (!normalized) return {};
  if (normalized === "none") return { thinking: { type: "disabled" } };
  if (!EFFORT_VARIANTS.has(normalized)) return {};
  const supportedLevels = Array.isArray(modelInfo?.supportedEffortLevels)
    ? modelInfo.supportedEffortLevels
    : null;
  if (supportedLevels && !supportedLevels.includes(normalized)) return {};
  return {
    effort: normalized,
    ...(modelInfo?.supportsAdaptiveThinking ? { thinking: { type: "adaptive" } } : {}),
  };
}
