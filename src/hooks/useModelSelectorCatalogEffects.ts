import { useEffect } from "react";
import type { HarnessId } from "@/agents";

export function useModelSelectorCatalogEffects(input: {
  open: boolean;
  inventoriesReady: boolean;
  harnessRows: HarnessId[];
  dialogHarnessId: HarnessId;
  lockedHarnessId: HarnessId | null;
  ensureCatalogForHarness: (harnessId: HarnessId) => Promise<void>;
  setDialogHarnessId: (harnessId: HarnessId) => void;
}) {
  useEffect(() => {
    if (!input.open || input.harnessRows.length === 0) return;
    if (input.harnessRows.includes(input.dialogHarnessId)) return;
    const next =
      input.lockedHarnessId && input.harnessRows.includes(input.lockedHarnessId)
        ? input.lockedHarnessId
        : input.harnessRows[0];
    if (!next) return;
    input.setDialogHarnessId(next);
    void input.ensureCatalogForHarness(next);
  }, [
    input.open,
    input.harnessRows,
    input.dialogHarnessId,
    input.lockedHarnessId,
    input.ensureCatalogForHarness,
    input.setDialogHarnessId,
  ]);

  useEffect(() => {
    if (!input.open || !input.inventoriesReady || input.harnessRows.length === 0) return;
    if (!input.harnessRows.includes(input.dialogHarnessId)) return;
    void input.ensureCatalogForHarness(input.dialogHarnessId);
  }, [
    input.open,
    input.inventoriesReady,
    input.harnessRows,
    input.dialogHarnessId,
    input.ensureCatalogForHarness,
  ]);
}
