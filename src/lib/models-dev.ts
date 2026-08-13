import {
  REASONING_EFFORTS,
  reasoningEffortsFromCatalogModel,
  selectCatalogModel,
  type FlatModelCatalog,
  type ModelCatalogHints,
} from "@opengui/protocol";
import type { Model } from "@/protocol/agent-types";
import type { HostModelConnection, ReasoningEffort } from "@/protocol/host-types";

type ModelsDevProviderCatalog = Record<
  string,
  { models?: Record<string, FlatModelCatalog[string]> }
>;

let catalogRequest: Promise<FlatModelCatalog | null> | null = null;

export function reasoningMetadataForModel(
  catalog: FlatModelCatalog | null,
  modelId: string,
  hints: ModelCatalogHints = {},
): Pick<Model, "name" | "release_date" | "capabilities" | "reasoningEfforts" | "limit"> {
  const metadata = selectCatalogModel(catalog, modelId, hints);

  // Unknown/custom models remain configurable, but use a conservative toggle-shaped
  // default rather than claiming every effort accepted by the Host is accepted upstream.
  if (!metadata) {
    return {
      name: modelId,
      release_date: "",
      capabilities: { reasoning: true },
      reasoningEfforts: ["none", "high"],
    };
  }

  return {
    name: metadata.name || modelId,
    release_date: metadata.release_date || "",
    capabilities: { reasoning: metadata.reasoning === true },
    reasoningEfforts: reasoningEffortsFromCatalogModel(metadata) as ReasoningEffort[] | undefined,
    ...(typeof metadata.limit?.context === "number" && metadata.limit.context > 0
      ? { limit: { context: metadata.limit.context } }
      : {}),
  };
}

async function loadModelsDevCatalog(): Promise<FlatModelCatalog | null> {
  catalogRequest ??= fetch("https://models.dev/api.json")
    .then((response) => {
      if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
      return response.json() as Promise<ModelsDevProviderCatalog>;
    })
    .then((providers) =>
      Object.fromEntries(
        Object.entries(providers).flatMap(([providerId, provider]) =>
          Object.entries(provider.models ?? {}).map(([modelId, model]) => [
            `${providerId}/${modelId}`,
            model,
          ]),
        ),
      ),
    )
    .catch(() => null);
  return catalogRequest;
}

export async function connectionsToModelProviders(connections: HostModelConnection[]) {
  const catalog = await loadModelsDevCatalog();
  return connections.map((connection) => ({
    id: connection.id,
    name: connection.label,
    source: "custom",
    models: Object.fromEntries(
      connection.modelIds.map((modelId) => {
        const configured = connection.modelCapabilities?.[modelId];
        const inferred = reasoningMetadataForModel(catalog, modelId, {
          baseUrl: connection.baseUrl,
        });
        const reasoning = configured?.reasoning ?? inferred.capabilities.reasoning;
        const explicitEfforts = configured?.reasoningEfforts?.length
          ? configured.reasoningEfforts.filter((effort) => REASONING_EFFORTS.includes(effort))
          : undefined;
        return [
          modelId,
          {
            id: modelId,
            ...inferred,
            name: configured?.displayName || inferred.name,
            capabilities: { reasoning },
            reasoningEfforts:
              reasoning === false
                ? undefined
                : (explicitEfforts ??
                  (inferred.capabilities.reasoning ? inferred.reasoningEfforts : ["none", "high"])),
            ...(configured?.context ? { limit: { context: configured.context } } : {}),
          },
        ];
      }),
    ),
  }));
}
