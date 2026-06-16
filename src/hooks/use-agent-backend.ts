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
  const [harnessId, setBackendId] = useState<ActiveHarnessId>(() => getStoredHarnessId());

  useEffect(() => {
    return onSettingsChange((change) => {
      if (change.key !== STORAGE_KEYS.HARNESS) return;
      setBackendId(getStoredHarnessId());
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
  const preferredBackendId = useCurrentHarnessId();
  const { sessions, activeSessionId, activeTargetBackendId } = useSessionState();
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  return resolveActiveResourceHarnessRoute({
    activeSession,
    activeTargetBackendId,
    preferredBackendId,
  });
}

export function useRoutedHarness(harnessId?: HarnessId) {
  const allBackends = useAllHarnesses();
  const route = useActiveResourceHarnessRoute();
  const resolvedBackendId = harnessId ?? route.harnessId;
  const openGuiClient = useOpenGuiClient();
  const backend = allBackends[resolvedBackendId] ?? openGuiClient.harnesses.get(resolvedBackendId);
  return { backend, route };
}

export function useHarness(harnessId?: HarnessId) {
  return useRoutedHarness(harnessId).backend;
}

export function useAvailableHarnessIds() {
  const allBackends = useAllHarnesses();
  return HARNESS_IDS.filter((harnessId) => Boolean(allBackends[harnessId]));
}

export function useBackendCapabilities() {
  return useHarness()?.capabilities;
}
