import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import type { OpenAiCompatibleConnection } from "./openai-chat.ts";

export type PiAiCatalogProviderId = "openai-codex" | "opencode" | "opencode-go";

const providers = {
  "openai-codex": openaiCodexProvider(),
  opencode: opencodeProvider(),
  "opencode-go": opencodeGoProvider(),
} as const;

function routeFor(model: Model<any>): "openai-chat" | "anthropic-messages" | "responses" | null {
  if (model.api === "openai-completions") return "openai-chat";
  if (model.api === "anthropic-messages") return "anthropic-messages";
  if (model.api === "openai-responses" || model.api === "openai-codex-responses")
    return "responses";
  return null;
}

/** Canonical built-in metadata shipped by pi-ai's generated models.dev catalogs. */
export function piAiCatalogConnection(
  providerId: PiAiCatalogProviderId,
  input: Pick<OpenAiCompatibleConnection, "id" | "label" | "baseUrl" | "defaultModelId">,
): OpenAiCompatibleConnection {
  const models = providers[providerId].getModels().flatMap((model) => {
    const route = routeFor(model);
    return route ? [{ model, route }] : [];
  });
  const modelIds = models.map(({ model }) => model.id);
  return {
    ...input,
    modelIds,
    defaultModelId: modelIds.includes(input.defaultModelId ?? "")
      ? input.defaultModelId
      : modelIds[0],
    modelRoutes: Object.fromEntries(models.map(({ model, route }) => [model.id, route])),
    modelCapabilities: Object.fromEntries(
      models.map(({ model }) => [
        model.id,
        {
          displayName: model.name,
          context: model.contextWindow,
          reasoning: model.reasoning,
          reasoningEfforts: model.reasoning
            ? getSupportedThinkingLevels(model).map((level) => (level === "off" ? "none" : level))
            : undefined,
        },
      ]),
    ),
  };
}

export function piAiFreeModelIds(providerId: "opencode") {
  return providers[providerId]
    .getModels()
    .filter((model) => routeFor(model) && model.cost.input === 0 && model.cost.output === 0)
    .map((model) => model.id);
}

export function piAiTextOnlyModelIds(providerId: PiAiCatalogProviderId) {
  return providers[providerId]
    .getModels()
    .filter((model) => routeFor(model) && !model.input.includes("image"))
    .map((model) => model.id);
}
