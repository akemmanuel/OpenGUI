import { HARNESS_IDS, type HarnessId } from "@/agents";
import type { HarnessInventory } from "@/types/electron";

export type HarnessInventoryViewStatus = "loading" | "ready" | "error";

export interface HarnessInventoryView {
  status: HarnessInventoryViewStatus;
  byHarnessId: Map<HarnessId, HarnessInventory>;
  installedHarnessIds: HarnessId[];
  modelReadyHarnessIds: HarnessId[];
  usableHarnessIds: HarnessId[];
  selectorHarnessIds: HarnessId[];
  hasInstalledHarness: boolean;
  hasModelReadyHarness: boolean;
  hasUsableHarness: boolean;
}

function isModelReady(inventory: HarnessInventory) {
  return inventory.status === "ready" && inventory.models.length > 0;
}

export function createHarnessInventoryView({
  inventories,
  candidateHarnessIds = HARNESS_IDS,
  lockedHarnessId = null,
  status = "ready",
}: {
  inventories: readonly HarnessInventory[];
  candidateHarnessIds?: readonly HarnessId[];
  lockedHarnessId?: HarnessId | null;
  status?: HarnessInventoryViewStatus;
}): HarnessInventoryView {
  const byHarnessId = new Map<HarnessId, HarnessInventory>();
  for (const inventory of inventories) {
    byHarnessId.set(inventory.harnessId, inventory);
  }

  const installedHarnessIds = candidateHarnessIds.filter(
    (harnessId) => byHarnessId.get(harnessId)?.installed === true,
  );
  const modelReadyHarnessIds = candidateHarnessIds.filter((harnessId) => {
    const inventory = byHarnessId.get(harnessId);
    return inventory ? isModelReady(inventory) : false;
  });

  return {
    status,
    byHarnessId,
    installedHarnessIds,
    modelReadyHarnessIds,
    usableHarnessIds: installedHarnessIds,
    selectorHarnessIds:
      status === "loading"
        ? []
        : candidateHarnessIds.filter((harnessId) => {
            if (lockedHarnessId === harnessId) return true;
            return byHarnessId.get(harnessId)?.installed === true;
          }),
    hasInstalledHarness: installedHarnessIds.length > 0,
    hasModelReadyHarness: modelReadyHarnessIds.length > 0,
    hasUsableHarness: installedHarnessIds.length > 0,
  };
}
