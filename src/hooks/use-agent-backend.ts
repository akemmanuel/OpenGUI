import { useEffect, useMemo, useState } from "react";
import type { HarnessId } from "@/agents";
import { HARNESS_IDS } from "@/agents";
import {
  resolveActiveResourceHarnessRoute,
  type HarnessRoute,
} from "@/hooks/agent-harness-routing";
import { useSessionState } from "@/hooks/use-agent-state";
import { STORAGE_KEYS } from "@/lib/constants";
import { onSettingsChange, storageGet } from "@/lib/safe-storage";
import { useOpenGuiClient } from "@/protocol/provider";

function getStoredHarnessId(): HarnessId {
  const stored = storageGet(STORAGE_KEYS.HARNESS);
  if (stored === "claude-code") return "claude-code";
  if (stored === "pi") return "pi";
  if (stored === "codex") return "codex";
  return "opencode";
}

export function useCurrentHarnessId() {
  const [harnessId, setBackendId] = useState<HarnessId>(() => getStoredHarnessId());

  useEffect(() => {
    return onSettingsChange((change) => {
      if (change.key !== STORAGE_KEYS.HARNESS) return;
      if (change.value === "claude-code") {
        setBackendId("claude-code");
        return;
      }
      if (change.value === "pi") {
        setBackendId("pi");
        return;
      }
      if (change.value === "codex") {
        setBackendId("codex");
        return;
      }
      setBackendId("opencode");
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
