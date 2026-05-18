import { useEffect, useMemo, useState } from "react";
import type { AgentBackendId } from "@/agents";
import { AGENT_BACKEND_IDS } from "@/agents";
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

function useResourceAgentBackendId() {
  const preferredBackendId = useCurrentAgentBackendId();
  const { sessions, activeSessionId, draftSessionBackendId } = useSessionState();
  const activeSession = sessions.find((session) => session.id === activeSessionId);
  return activeSession?._backendId ?? draftSessionBackendId ?? preferredBackendId;
}

export function useAgentBackend(backendId?: AgentBackendId) {
  const allBackends = useAllAgentBackends();
  const resourceBackendId = useResourceAgentBackendId();
  const resolvedBackendId = backendId ?? resourceBackendId;
  const openGuiClient = useOpenGuiClient();
  return allBackends[resolvedBackendId] ?? openGuiClient.agentBackends.get(resolvedBackendId);
}

export function useAvailableBackendIds() {
  const allBackends = useAllAgentBackends();
  return AGENT_BACKEND_IDS.filter((backendId) => Boolean(allBackends[backendId]));
}

export function useBackendCapabilities() {
  return useAgentBackend()?.capabilities;
}
