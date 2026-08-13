import {
  reasoningEffortsFromCatalogModel,
  selectCatalogModel,
  type FlatModelCatalog,
  type ModelReasoningEffort,
} from "@opengui/protocol";
import type { HostModelConnection } from "./opengui-host.ts";

type ModelsDevProviderCatalog = Record<
  string,
  { models?: Record<string, FlatModelCatalog[string]> }
>;

export async function loadModelsDevCatalog(
  fetchImpl: typeof fetch,
): Promise<FlatModelCatalog | null> {
  try {
    const response = await fetchImpl("https://models.dev/api.json");
    if (!response.ok) return null;
    const providers = (await response.json()) as ModelsDevProviderCatalog;
    return Object.fromEntries(
      Object.entries(providers).flatMap(([providerId, provider]) =>
        Object.entries(provider.models ?? {}).map(([modelId, model]) => [
          `${providerId}/${modelId}`,
          model,
        ]),
      ),
    );
  } catch {
    return null;
  }
}

export function resolveConnectionReasoningEfforts(
  connection: HostModelConnection,
  modelId: string,
  catalog: FlatModelCatalog | null,
): ModelReasoningEffort[] {
  const configured = connection.modelCapabilities?.[modelId];
  if (configured?.reasoning === false) return [];
  if (configured?.reasoningEfforts?.length) {
    return [...configured.reasoningEfforts] as ModelReasoningEffort[];
  }
  const catalogModel = selectCatalogModel(catalog, modelId, { baseUrl: connection.baseUrl });
  if (catalogModel?.reasoning === true) {
    return reasoningEffortsFromCatalogModel(catalogModel) ?? ["none", "high"];
  }
  return ["none", "high"];
}
