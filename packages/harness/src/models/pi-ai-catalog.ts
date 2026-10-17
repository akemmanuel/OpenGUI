import {
  createModels,
  getSupportedThinkingLevels,
  type Api,
  type AuthContext,
  type CreateModelsOptions,
  type Model,
  type Models,
  type Provider,
} from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { OpenAiCompatibleConnection } from "./openai-chat.ts";

export type PiAiCatalogProviderId = string;

/** Non-secret description of a pi provider and the sign-in methods it offers. */
export interface PiProviderDescriptor {
  id: string;
  name: string;
  apiKey?: { name: string; interactive: boolean };
  oauth?: { name: string; loginLabel?: string; subscription: boolean };
}

// pi loads its OAuth flows through runtime-relative imports, which a bundled backend cannot
// resolve. Registering them statically keeps sign-in and token refresh working when bundled.
registerBunOAuthFlows();

let registry: ReadonlyMap<string, Provider> | undefined;

/** Every pi provider that can serve chat models, keyed by pi provider id. */
export function piProviders(): ReadonlyMap<string, Provider> {
  registry ??= new Map(
    builtinProviders()
      .filter((provider) => provider.getModels().length > 0)
      .map((provider) => [provider.id, provider]),
  );
  return registry;
}

export function piProvider(providerId: string) {
  return piProviders().get(providerId);
}

export function piProviderDescriptors(): PiProviderDescriptor[] {
  return [...piProviders().values()]
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      ...(provider.auth.apiKey
        ? {
            apiKey: {
              name: provider.auth.apiKey.name,
              interactive: typeof provider.auth.apiKey.login === "function",
            },
          }
        : {}),
      ...(provider.auth.oauth
        ? {
            oauth: {
              name: provider.auth.oauth.name,
              loginLabel: provider.auth.oauth.loginLabel,
              subscription: provider.auth.oauth.isSubscription === true,
            },
          }
        : {}),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** A pi `Models` collection over every provider, resolving auth through `options.credentials`. */
export function createPiModels(options: CreateModelsOptions): Models {
  const models = createModels(options);
  for (const provider of piProviders().values()) models.setProvider(provider);
  return models;
}

/** Auth context with no ambient credentials: no environment variables and no credential files. */
export const ISOLATED_AUTH_CONTEXT: AuthContext = {
  env: async () => undefined,
  fileExists: async () => false,
};

/** Installed pi models for a provider. They supply trusted endpoints, never the listing. */
export function piBundledModels(providerId: string): readonly Model<Api>[] {
  return piProvider(providerId)?.getModels() ?? [];
}

/** Project pi metadata into the Host's connection format. */
export function piAiCatalogConnection(
  providerId: PiAiCatalogProviderId,
  input: Pick<OpenAiCompatibleConnection, "id" | "label" | "baseUrl" | "defaultModelId">,
  catalog: readonly Model<Api>[] = piBundledModels(providerId),
): OpenAiCompatibleConnection {
  const modelIds = catalog.map((model) => model.id);
  return {
    ...input,
    modelIds,
    defaultModelId: modelIds.includes(input.defaultModelId ?? "")
      ? input.defaultModelId
      : modelIds[0],
    modelCapabilities: Object.fromEntries(
      catalog.map((model) => [
        model.id,
        {
          displayName: model.name,
          context: model.contextWindow,
          maxTokens: model.maxTokens,
          input: model.input,
          thinkingLevelMap: model.thinkingLevelMap,
          compat: model.compat ? { ...model.compat } : undefined,
          reasoning: model.reasoning,
          reasoningEfforts: model.reasoning
            ? getSupportedThinkingLevels(model).map((level) => (level === "off" ? "none" : level))
            : undefined,
        },
      ]),
    ),
  };
}
