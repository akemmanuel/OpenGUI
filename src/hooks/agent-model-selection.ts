import type { Agent, Provider } from "@/protocol/agent-types";
import type { SelectedModel } from "@opengui/protocol";

/**
 * Given the list of providers and a `provider -> modelID` default map from the
 * server, resolve the first valid `SelectedModel` that exists.
 */
export function resolveServerDefaultModel(
  providers: Provider[],
  providerDefaults: Record<string, string>,
): SelectedModel | null {
  for (const provider of providers) {
    const modelID = providerDefaults[provider.id];
    if (typeof modelID !== "string") continue;
    if (!(modelID in provider.models)) continue;
    return { providerID: provider.id, modelID };
  }

  for (const raw of Object.values(providerDefaults)) {
    if (typeof raw !== "string") continue;
    const splitIdx = raw.indexOf("/");
    if (splitIdx <= 0 || splitIdx >= raw.length - 1) continue;
    const providerID = raw.slice(0, splitIdx);
    const modelID = raw.slice(splitIdx + 1);
    const provider = providers.find((p) => p.id === providerID);
    if (!provider || !(modelID in provider.models)) continue;
    return { providerID, modelID };
  }

  return null;
}

export function isModelAvailable(providers: Provider[], model: SelectedModel | null) {
  if (!model) return false;
  const provider = providers.find((p) => p.id === model.providerID);
  return !!provider && model.modelID in provider.models;
}

export function isAgentAvailable(agents: Agent[], agent: string | null | undefined) {
  if (agent == null) return true;
  return agents.some((candidate) => candidate.name === agent);
}

export function selectedModelsEqual(
  a: SelectedModel | null | undefined,
  b: SelectedModel | null | undefined,
) {
  return a?.providerID === b?.providerID && a?.modelID === b?.modelID;
}

export function selectedVariantsEqual(a: string | null | undefined, b: string | null | undefined) {
  return (a ?? null) === (b ?? null);
}

export function resolveAvailableAgent({
  agents,
  sessionAgent,
  hasSessionAgent,
  workspaceAgent,
}: {
  agents: Agent[];
  sessionAgent?: string | null;
  hasSessionAgent: boolean;
  workspaceAgent?: string | null;
}) {
  const preferred = hasSessionAgent ? sessionAgent : workspaceAgent;
  return preferred && isAgentAvailable(agents, preferred) ? preferred : null;
}
