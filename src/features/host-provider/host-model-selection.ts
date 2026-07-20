import type { OpenGuiHostClient } from "@/protocol/host-types";
import type { SelectedModel } from "@opengui/protocol";

export function persistHostModelSelection(
  host: OpenGuiHostClient,
  sessionId: string | null,
  model: SelectedModel,
) {
  if (!sessionId) return Promise.resolve(null);
  return host.setModel(sessionId, {
    connectionId: model.providerID,
    modelId: model.modelID,
  });
}
