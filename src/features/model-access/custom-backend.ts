import type { HostModelConnection, ReasoningEffort } from "@/protocol/host-types";

export type ModelRoute = "openai-chat" | "anthropic-messages" | "responses";

export type EditableUpstreamModel = {
  key: string;
  id: string;
  displayName: string;
  route: ModelRoute;
  reasoning: boolean;
  context: string;
  reasoningEfforts: ReasoningEffort[];
};

export type CustomBackendDraft = {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  plane: "host" | "team" | "user";
  defaultModelId: string;
  models: EditableUpstreamModel[];
};

export type CustomBackendErrors = {
  label?: boolean;
  baseUrl?: "required" | "invalid";
  models?: "required" | "duplicate";
  modelIds: Set<string>;
  contexts: Set<string>;
};

export function emptyUpstreamModel(id = ""): EditableUpstreamModel {
  return {
    key: `model_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    id,
    displayName: "",
    route: "openai-chat",
    reasoning: false,
    context: "",
    reasoningEfforts: [],
  };
}

export function createCustomBackendDraft(plane: CustomBackendDraft["plane"]): CustomBackendDraft {
  return {
    id: `connection_${Date.now()}`,
    label: "",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    plane,
    defaultModelId: "",
    models: [emptyUpstreamModel()],
  };
}

export function editCustomBackendDraft(connection: HostModelConnection): CustomBackendDraft {
  return {
    id: connection.id,
    label: connection.label,
    baseUrl: connection.baseUrl,
    apiKey: "",
    plane: connection.plane ?? "host",
    defaultModelId: connection.defaultModelId ?? connection.modelIds[0] ?? "",
    models: connection.modelIds.map((id) => {
      const capabilities = connection.modelCapabilities?.[id];
      return {
        ...emptyUpstreamModel(id),
        displayName: capabilities?.displayName ?? "",
        route: connection.modelRoutes?.[id] ?? "openai-chat",
        reasoning: capabilities?.reasoning ?? false,
        context: capabilities?.context ? String(capabilities.context) : "",
        reasoningEfforts: capabilities?.reasoningEfforts ?? [],
      };
    }),
  };
}

export function validateCustomBackend(draft: CustomBackendDraft): CustomBackendErrors {
  const errors: CustomBackendErrors = { modelIds: new Set(), contexts: new Set() };
  if (!draft.label.trim()) errors.label = true;
  if (!draft.baseUrl.trim()) errors.baseUrl = "required";
  else {
    try {
      const url = new URL(draft.baseUrl.trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") errors.baseUrl = "invalid";
    } catch {
      errors.baseUrl = "invalid";
    }
  }
  const ids = draft.models.map((model) => model.id.trim());
  if (ids.every((id) => !id)) errors.models = "required";
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (!id || seen.has(id)) errors.modelIds.add(draft.models[index]!.key);
    if (id) seen.add(id);
  });
  if (ids.some((id, index) => id && ids.indexOf(id) !== index)) errors.models = "duplicate";
  draft.models.forEach((model) => {
    if (model.context && (!Number.isInteger(Number(model.context)) || Number(model.context) <= 0)) {
      errors.contexts.add(model.key);
    }
  });
  return errors;
}

export function buildCustomModelConnection(draft: CustomBackendDraft): HostModelConnection | null {
  const errors = validateCustomBackend(draft);
  if (
    errors.label ||
    errors.baseUrl ||
    errors.models ||
    errors.modelIds.size ||
    errors.contexts.size
  )
    return null;
  const models = draft.models.map((model) => ({ ...model, id: model.id.trim() }));
  const modelIds = models.map((model) => model.id);
  const defaultModelId = modelIds.includes(draft.defaultModelId)
    ? draft.defaultModelId
    : modelIds[0];
  return {
    id: draft.id,
    label: draft.label.trim(),
    baseUrl: draft.baseUrl.trim().replace(/\/+$/u, ""),
    apiKey: draft.apiKey.trim() || undefined,
    modelIds,
    defaultModelId,
    plane: draft.plane,
    credentialKind: "byok",
    modelRoutes: Object.fromEntries(models.map((model) => [model.id, model.route])),
    modelCapabilities: Object.fromEntries(
      models.map((model) => [
        model.id,
        {
          displayName: model.displayName.trim() || undefined,
          context: model.context ? Number(model.context) : undefined,
          reasoning: model.reasoning,
          ...(model.reasoning && model.reasoningEfforts.length
            ? { reasoningEfforts: model.reasoningEfforts }
            : {}),
        },
      ]),
    ),
  };
}
