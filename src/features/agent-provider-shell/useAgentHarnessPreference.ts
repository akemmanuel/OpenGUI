import { useEffect, useMemo, useState } from "react";
import { DEFAULT_HARNESS_ID, HARNESS_IDS, type ActiveHarnessId, type HarnessId } from "@/agents";
import { STORAGE_KEYS } from "@/lib/constants";
import { onSettingsChange, storageGet } from "@/lib/safe-storage";
import { useOpenGuiClient } from "@/protocol/provider";

export function useAgentHarnessPreference() {
  const [preferredHarnessId, setPreferredHarnessId] = useState<HarnessId>(() => {
    const stored = storageGet(STORAGE_KEYS.HARNESS);
    return HARNESS_IDS.includes(stored as ActiveHarnessId)
      ? (stored as ActiveHarnessId)
      : DEFAULT_HARNESS_ID;
  });

  useEffect(() => {
    return onSettingsChange((change) => {
      if (change.key !== STORAGE_KEYS.HARNESS) return;
      setPreferredHarnessId(
        HARNESS_IDS.includes(change.value as ActiveHarnessId)
          ? (change.value as ActiveHarnessId)
          : DEFAULT_HARNESS_ID,
      );
    });
  }, []);

  const openGuiClient = useOpenGuiClient();
  const allHarnesses = useMemo(() => openGuiClient.harnesses.list(), [openGuiClient]);
  const backendsById = useMemo(
    () =>
      Object.fromEntries(
        allHarnesses.map((backend) => [backend.id as HarnessId, backend]),
      ) as Record<HarnessId, (typeof allHarnesses)[number]>,
    [allHarnesses],
  );
  const discoveryHarnessIds = useMemo(
    () => allHarnesses.map((backend) => backend.id as HarnessId),
    [allHarnesses],
  );

  return {
    preferredHarnessId,
    setPreferredHarnessId,
    openGuiClient,
    allHarnesses,
    backendsById,
    discoveryHarnessIds,
  };
}
