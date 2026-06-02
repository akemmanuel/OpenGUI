import { useEffect, useMemo, useState } from "react";
import type { AgentBackendId } from "@/agents";
import { AGENT_BACKEND_IDS } from "@/agents";
import {
  resolveActiveResourceHarnessRoute,
  type HarnessRoute,
} from "@/hooks/agent-harness-routing";
import { useSessionState } from "@/hooks/use-agent-state";
import { STORAGE_KEYS } from "@/lib/constants";
import { onSettingsChange, storageGet } from "@/lib/safe-storage";
import { useOpenGuiClient } from "@/protocol/provider";

function getStoredAgentBackendId(): AgentBackendId {
  const stored = storageGet(STORAGE_KEYS.AGENT_BACKEND);
  if (stored === "claude-code") return "claude-code";
  if (stored === "pi") return "pi";
  if (stored === "codex") return "codex";
  return "opencode";
}

export function useCurrentAgentBackendId() {
  const [backendId, setBackendId] = useState<AgentBackendId>(() => getStoredAgentBackendId());

  useEffect(() => {
    return onSettingsChange((change) => {
      if (change.key !== STORAGE_KEYS.AGENT_BACKEND) return;
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

  return backendId;
}

function useAllAgentBackends() {
  const openGuiClient = useOpenGuiClient();
  return useMemo(() => {
    const all = openGuiClient.agentBackends.list();
    return Object.fromEntries(
      all.map((backend) => [backend.id as AgentBackendId, backend]),
    ) as Record<AgentBackendId, NonNullable<(typeof all)[number]>>;
  }, [openGuiClient]);
}

export function useActiveResourceHarnessRoute(): HarnessRoute {
  const preferredBackendId = useCurrentAgentBackendId();
  const { sessions, activeSessionId, activeTargetBackendId } = useSessionState();
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  return resolveActiveResourceHarnessRoute({
    activeSession,
    activeTargetBackendId,
    preferredBackendId,
  });
}

export function useRoutedAgentBackend(backendId?: AgentBackendId) {
  const allBackends = useAllAgentBackends();
  const route = useActiveResourceHarnessRoute();
  const resolvedBackendId = backendId ?? route.harnessId;
  const openGuiClient = useOpenGuiClient();
  const backend =
    allBackends[resolvedBackendId] ?? openGuiClient.agentBackends.get(resolvedBackendId);
  return { backend, route };
}

export function useAgentBackend(backendId?: AgentBackendId) {
  return useRoutedAgentBackend(backendId).backend;
}

export function useAvailableBackendIds() {
  const allBackends = useAllAgentBackends();
  return AGENT_BACKEND_IDS.filter((backendId) => Boolean(allBackends[backendId]));
}

export function useBackendCapabilities() {
  return useAgentBackend()?.capabilities;
}
