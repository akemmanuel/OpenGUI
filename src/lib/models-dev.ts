import type { HostModelConnection } from "@/protocol/host-types";
import type { ReasoningEffort } from "@/protocol/host-types";
import type { Model } from "@/protocol/agent-types";

interface ModelsDevModel {
  name?: string;
  release_date?: string;
  reasoning?: boolean;
  reasoning_options?: Array<{ type?: string; values?: unknown[] }>;
}

type ModelsDevCatalog = Record<string, ModelsDevModel>;
type ModelsDevProviderCatalog = Record<string, { models?: Record<string, ModelsDevModel> }>;

const SUPPORTED_EFFORTS: ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
let catalogRequest: Promise<ModelsDevCatalog | null> | null = null;

export function reasoningMetadataForModel(
  catalog: ModelsDevCatalog | null,
  modelId: string,
): Pick<Model, "name" | "release_date" | "capabilities" | "reasoningEfforts"> {
  // models.json is keyed as provider/model. A connection can use any label or URL,
  // so match its API model id rather than guessing its provider.
  const matches = catalog
    ? Object.entries(catalog)
        .filter(([key]) => key === modelId || key.endsWith(`/${modelId}`))
        .map(([, model]) => model)
    : [];
  const reasoningMatches = matches.filter((model) => model.reasoning === true);

  // Unknown/custom models remain configurable: models.dev is advisory and an
  // unavailable catalog must not remove functionality from self-hosted models.
  if (matches.length === 0) {
    return {
      name: modelId,
      release_date: "",
      capabilities: { reasoning: true },
      reasoningEfforts: [...SUPPORTED_EFFORTS],
    };
  }

  const efforts = new Set<ReasoningEffort>();
  for (const model of reasoningMatches) {
    for (const option of model.reasoning_options ?? []) {
      if (option.type === "toggle") efforts.add("none");
      if (option.type !== "effort") continue;
      for (const value of option.values ?? []) {
        if (SUPPORTED_EFFORTS.includes(value as ReasoningEffort)) {
          efforts.add(value as ReasoningEffort);
        }
      }
    }
  }
  // Toggle/budget based reasoning models do not publish effort values. The Host
  // currently exposes those through its normalized off/high setting.
  const reasoningEfforts =
    efforts.size > 0
      ? SUPPORTED_EFFORTS.filter((effort) => efforts.has(effort))
      : reasoningMatches.length > 0
        ? (["none", "high"] as ReasoningEffort[])
        : undefined;
  const metadata = reasoningMatches[0] ?? matches[0];
  return {
    name: metadata?.name || modelId,
    release_date: metadata?.release_date || "",
    capabilities: { reasoning: reasoningMatches.length > 0 },
    reasoningEfforts,
  };
}

async function loadModelsDevCatalog(): Promise<ModelsDevCatalog | null> {
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
      connection.modelIds.map((modelId) => [
        modelId,
        { id: modelId, ...reasoningMetadataForModel(catalog, modelId) },
      ]),
    ),
  }));
}
