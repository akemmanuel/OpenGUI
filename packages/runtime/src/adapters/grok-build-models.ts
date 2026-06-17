// @ts-nocheck

export const DEFAULT_PROVIDER_ID = "xai";
export const DEFAULT_MODEL_ID = "grok-build";

function makeModel(id, name, options = {}) {
  const reasoning = options.reasoning ?? true;
  const context =
    typeof options.context === "number" && Number.isFinite(options.context)
      ? options.context
      : 200_000;
  return {
    id,
    name,
    release_date: options.releaseDate ?? "2026-05-25",
    capabilities: {
      reasoning,
      temperature: false,
      toolcall: true,
      attachment: false,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
    },
    limit: {
      context,
      output: 8_192,
    },
    status: "active",
    ...(options.description ? { description: options.description } : {}),
  };
}

export function mapGrokModelEntry(entry) {
  const id = String(entry?.modelId ?? entry?.id ?? "").trim();
  if (!id) return null;
  const context = entry?._meta?.totalContextTokens;
  return makeModel(id, String(entry?.name ?? id), {
    description: typeof entry?.description === "string" ? entry.description : undefined,
    reasoning: entry?._meta?.agentType !== "cursor",
    context: typeof context === "number" ? context : undefined,
  });
}

export function buildGrokProvidersFromModelState(modelState) {
  const models = {};
  const available = Array.isArray(modelState?.availableModels) ? modelState.availableModels : [];
  for (const entry of available) {
    const model = mapGrokModelEntry(entry);
    if (model) models[model.id] = model;
  }
  if (!Object.keys(models).length) {
    models[DEFAULT_MODEL_ID] = makeModel(DEFAULT_MODEL_ID, "Grok Build");
  }
  const currentModelId =
    typeof modelState?.currentModelId === "string" && models[modelState.currentModelId]
      ? modelState.currentModelId
      : models[DEFAULT_MODEL_ID]
        ? DEFAULT_MODEL_ID
        : Object.keys(models)[0];
  return {
    providers: [
      {
        id: DEFAULT_PROVIDER_ID,
        name: "xAI",
        source: "subscription",
        env: ["XAI_API_KEY"],
        options: {},
        models,
      },
    ],
    default: {
      [DEFAULT_PROVIDER_ID]: currentModelId,
    },
    connected: [DEFAULT_PROVIDER_ID],
    authKindByProvider: {
      [DEFAULT_PROVIDER_ID]: process.env.XAI_API_KEY?.trim() ? "env" : "subscription",
    },
  };
}

export function resolveSelectedModelId(selectedModel) {
  if (selectedModel?.modelID && typeof selectedModel.modelID === "string") {
    return selectedModel.modelID;
  }
  if (selectedModel?.modelId && typeof selectedModel.modelId === "string") {
    return selectedModel.modelId;
  }
  return DEFAULT_MODEL_ID;
}
