import { useEffect, useMemo, useState } from "react";
import type { ActiveHarnessId, HarnessId } from "@/agents";
import { DEFAULT_HARNESS_ID, HARNESS_IDS } from "@/agents";
import {
  resolveActiveResourceHarnessRoute,
  type HarnessRoute,
} from "@/hooks/agent-harness-routing";
import { useSessionState } from "@/hooks/use-agent-state";
import { STORAGE_KEYS } from "@/lib/constants";
import { onSettingsChange, storageGet } from "@/lib/safe-storage";
import { useOpenGuiClient } from "@/protocol/provider";

function getStoredHarnessId(): ActiveHarnessId {
  const stored = storageGet(STORAGE_KEYS.HARNESS);
  return HARNESS_IDS.includes(stored as ActiveHarnessId)
    ? (stored as ActiveHarnessId)
    : DEFAULT_HARNESS_ID;
}

export function useCurrentHarnessId(): ActiveHarnessId {
  const [harnessId, setHarnessId] = useState<ActiveHarnessId>(() => getStoredHarnessId());

  useEffect(() => {
    return onSettingsChange((change) => {
      if (change.key !== STORAGE_KEYS.HARNESS) return;
      setHarnessId(getStoredHarnessId());
    });
  }, []);

  return harnessId;
}

function useAllHarnesses() {
  const openGuiClient = useOpenGuiClient();
  return useMemo(() => {
    const all = openGuiClient.harnesses.list();
    return Object.fromEntries(all.map((backend) => [backend.id as HarnessId, backend])) as Record<
      HarnessId,
      NonNullable<(typeof all)[number]>
    >;
  }, [openGuiClient]);
}

export function useActiveResourceHarnessRoute(): HarnessRoute {
  const preferredHarnessId = useCurrentHarnessId();
  const { sessions, activeSessionId, activeTargetHarnessId } = useSessionState();
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  return resolveActiveResourceHarnessRoute({
    activeSession,
    activeTargetHarnessId,
    preferredHarnessId,
  });
}

export function useRoutedHarness(harnessId?: HarnessId) {
  const allHarnesses = useAllHarnesses();
  const route = useActiveResourceHarnessRoute();
  const resolvedHarnessId = harnessId ?? route.harnessId;
  const openGuiClient = useOpenGuiClient();
  const backend = allHarnesses[resolvedHarnessId] ?? openGuiClient.harnesses.get(resolvedHarnessId);
  return { backend, route };
}

export function useHarness(harnessId?: HarnessId) {
  return useRoutedHarness(harnessId).backend;
}

export function useAvailableHarnessIds() {
  const allHarnesses = useAllHarnesses();
  return HARNESS_IDS.filter((harnessId) => Boolean(allHarnesses[harnessId]));
}

export function useBackendCapabilities() {
  return useHarness()?.capabilities;
}
