// @ts-nocheck

export const CODEX_VALID_VARIANTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
export const DEFAULT_MODEL_ID = "gpt-5.4";
export const DEFAULT_PROVIDER_ID = "openai";

const STATIC_CODEX_MODEL_SPECS = [
  { id: "gpt-5.5", name: "GPT-5.5", reasoning: true, image: true, releaseDate: "2026-04-29" },
  { id: "gpt-5.4", name: "GPT-5.4", reasoning: true, image: true, releaseDate: "2026-04-01" },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    reasoning: true,
    image: true,
    releaseDate: "2026-04-01",
  },
  {
    id: "gpt-5.4-nano",
    name: "GPT-5.4 Nano",
    reasoning: false,
    image: true,
    releaseDate: "2026-04-01",
  },
  { id: "gpt-5", name: "GPT-5", reasoning: true, image: true },
  { id: "gpt-5-mini", name: "GPT-5 Mini", reasoning: true, image: true },
  { id: "gpt-5-nano", name: "GPT-5 Nano", reasoning: false, image: true },
  { id: "gpt-5-codex", name: "GPT-5 Codex", reasoning: true, image: true, status: "deprecated" },
  {
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    reasoning: true,
    image: true,
    releaseDate: "2026-03-01",
  },
  { id: "gpt-5.2", name: "GPT-5.2", reasoning: true, image: true },
  { id: "gpt-5.2-mini", name: "GPT-5.2 Mini", reasoning: true, image: true },
  {
    id: "gpt-5.2-codex",
    name: "GPT-5.2 Codex",
    reasoning: true,
    image: true,
    status: "deprecated",
  },
  {
    id: "codex-mini-latest",
    name: "Codex Mini Latest",
    reasoning: true,
    image: true,
    status: "deprecated",
  },
];

export const STATIC_CODEX_MODELS = Object.fromEntries(
  STATIC_CODEX_MODEL_SPECS.map((spec) => [
    spec.id,
    makeModel(spec.id, spec.name, {
      reasoning: spec.reasoning,
      image: spec.image,
      releaseDate: spec.releaseDate,
      status: spec.status,
    }),
  ]),
);

export const STATIC_CODEX_PROVIDER = {
  providers: [
    {
      id: DEFAULT_PROVIDER_ID,
      name: "OpenAI",
      source: "api",
      env: ["CODEX_API_KEY", "OPENAI_API_KEY"],
      options: {},
      models: STATIC_CODEX_MODELS,
    },
  ],
  default: {
    [DEFAULT_PROVIDER_ID]: DEFAULT_MODEL_ID,
  },
};

function makeModel(
  id,
  name,
  { reasoning, image, releaseDate, status = "active", variants = null, context, output },
) {
  return {
    id,
    providerID: DEFAULT_PROVIDER_ID,
    api: { id, url: "https://api.openai.com", npm: "@openai/codex-sdk" },
    name,
    family: id,
    capabilities: {
      temperature: false,
      reasoning,
      attachment: image,
      toolcall: true,
      input: { text: true, audio: false, image, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: {
      context: Number.isFinite(context) ? context : 200_000,
      output: Number.isFinite(output) ? output : 8_192,
    },
    status,
    options: {},
    headers: {},
    release_date: releaseDate,
    variants: variants ?? undefined,
  };
}

function titleCaseVariant(value) {
  if (value === "xhigh") return "Extra High";
  if (value === "none") return "None";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalizeReasoningEfforts(value) {
  if (!Array.isArray(value)) return [];
  const efforts = [];
  for (const entry of value) {
    const effort =
      typeof entry === "string"
        ? entry
        : typeof entry?.reasoningEffort === "string"
          ? entry.reasoningEffort
          : null;
    if (!effort || efforts.includes(effort)) continue;
    efforts.push(effort);
  }
  return efforts;
}

function humanizeModelId(id) {
  return id
    .replace(/^gpt/i, "GPT")
    .replace(/-([a-z])/g, (_match, char) => ` ${char.toUpperCase()}`);
}

function buildVariantsFromReasoningEfforts(efforts, defaultEffort) {
  if (!efforts.length) return {};
  const ordered =
    typeof defaultEffort === "string" && efforts.includes(defaultEffort)
      ? [defaultEffort, ...efforts.filter((effort) => effort !== defaultEffort)]
      : efforts;
  return Object.fromEntries(ordered.map((effort) => [effort, { label: titleCaseVariant(effort) }]));
}

export function mapCodexAppServerModel(model) {
  if (!model || typeof model !== "object") return null;
  if (model.hidden === true) return null;
  const id =
    typeof model.model === "string" ? model.model : typeof model.id === "string" ? model.id : null;
  if (!id) return null;
  const fallback = STATIC_CODEX_MODELS[id];
  const efforts = normalizeReasoningEfforts(model.supportedReasoningEfforts);
  const variants = buildVariantsFromReasoningEfforts(efforts, model.defaultReasoningEffort);
  const reasoning = efforts.length > 0 ? efforts.some((effort) => effort !== "none") : true;
  const image = fallback?.capabilities?.input?.image ?? true;
  const name =
    typeof model.displayName === "string" && model.displayName.trim()
      ? model.displayName.trim()
      : (fallback?.name ?? humanizeModelId(id));
  return makeModel(id, name, {
    reasoning,
    image,
    releaseDate: fallback?.release_date,
    status:
      typeof model.deprecationState === "string" && model.deprecationState !== "active"
        ? "deprecated"
        : (fallback?.status ?? "active"),
    variants,
    context:
      typeof model.contextWindow === "number"
        ? model.contextWindow
        : typeof model.modelContextWindow === "number"
          ? model.modelContextWindow
          : fallback?.limit?.context,
    output:
      typeof model.maxOutputTokens === "number" ? model.maxOutputTokens : fallback?.limit?.output,
  });
}

function selectDefaultModelId(models) {
  if (models["gpt-5.5"]) return "gpt-5.5";
  if (models[DEFAULT_MODEL_ID]) return DEFAULT_MODEL_ID;
  return Object.keys(models)[0] ?? DEFAULT_MODEL_ID;
}

export function buildCodexProviderFromModels(models) {
  const defaultModelId = selectDefaultModelId(models);
  return {
    providers: [{ ...STATIC_CODEX_PROVIDER.providers[0], models }],
    default: { [DEFAULT_PROVIDER_ID]: defaultModelId },
  };
}
