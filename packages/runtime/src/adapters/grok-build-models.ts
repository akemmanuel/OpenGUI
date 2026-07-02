export const DEFAULT_PROVIDER_ID = "xai";
export const DEFAULT_MODEL_ID = "grok-build";

type GrokModelOptions = {
  reasoning?: boolean;
  context?: number;
  releaseDate?: string;
  description?: string;
};

type GrokModelRecord = {
  id: string;
  name: string;
  release_date: string;
  capabilities: {
    reasoning: boolean;
    temperature: boolean;
    toolcall: boolean;
    attachment: boolean;
    input: Record<string, boolean>;
    output: Record<string, boolean>;
  };
  limit: { context: number; output: number };
  status: "active";
  description?: string;
};

function makeModel(id: string, name: string, options: GrokModelOptions = {}): GrokModelRecord {
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

export function mapGrokModelEntry(entry: Record<string, unknown> | null | undefined) {
  const id = String(entry?.modelId ?? entry?.id ?? "").trim();
  if (!id) return null;
  const meta = entry?._meta as { totalContextTokens?: number; agentType?: string } | undefined;
  const context = meta?.totalContextTokens;
  return makeModel(id, String(entry?.name ?? id), {
    description: typeof entry?.description === "string" ? entry.description : undefined,
    reasoning: meta?.agentType !== "cursor",
    context: typeof context === "number" ? context : undefined,
  });
}

export function buildGrokProvidersFromModelState(modelState: {
  availableModels?: unknown[];
  currentModelId?: string;
} | null | undefined) {
  const models: Record<string, GrokModelRecord> = {};
  const available = Array.isArray(modelState?.availableModels) ? modelState.availableModels : [];
  for (const entry of available) {
    const model = mapGrokModelEntry(
      entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null,
    );
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
        : Object.keys(models)[0]!;
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

export function resolveSelectedModelId(selectedModel: { id?: string; modelID?: string } | null | undefined) {
  const id = selectedModel?.id ?? selectedModel?.modelID;
  return typeof id === "string" && id.trim() ? id.trim() : DEFAULT_MODEL_ID;
}