import type { HostSessionSnapshot } from "@/protocol/host-types";
import type { SelectedModel } from "@opengui/protocol";

export function selectedModelFromHostSnapshot(snapshot: HostSessionSnapshot): SelectedModel | null {
  if (!snapshot.model) return null;
  return {
    providerID: snapshot.model.connectionId,
    modelID: snapshot.model.modelId,
  };
}
