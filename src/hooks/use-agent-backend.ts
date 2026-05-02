import { useEffect, useMemo, useState } from "react";
import type { AgentBackendId } from "@/agents";
import { AGENT_BACKEND_IDS, getAllAgentBackends, getCurrentAgentBackend } from "@/agents";
import { useSessionState } from "@/hooks/use-agent-state";
import { STORAGE_KEYS } from "@/lib/constants";
import { onSettingsChange, storageGet, storageSet } from "@/lib/safe-storage";

export function getStoredAgentBackendId(): AgentBackendId {
	const stored = storageGet(STORAGE_KEYS.AGENT_BACKEND);
	if (stored === "claude-code") return "claude-code";
	if (stored === "pi") return "pi";
	if (stored === "codex") return "codex";
	return "opencode";
}

export function setStoredAgentBackendId(backendId: AgentBackendId) {
	storageSet(STORAGE_KEYS.AGENT_BACKEND, backendId);
}

export function useCurrentAgentBackendId() {
	const [backendId, setBackendId] = useState<AgentBackendId>(() =>
		getStoredAgentBackendId(),
	);

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

export function useAllAgentBackends() {
	return useMemo(() => {
		const all = getAllAgentBackends(window.electronAPI);
		return Object.fromEntries(
			all.map((backend) => [backend.id as AgentBackendId, backend]),
		) as Record<AgentBackendId, NonNullable<(typeof all)[number]>>;
	}, []);
}

export function useActiveAgentBackendId() {
	const preferredBackendId = useCurrentAgentBackendId();
	const { sessions, activeSessionId, draftSessionBackendId } = useSessionState();
	const activeSession = sessions.find((session) => session.id === activeSessionId);
	if (activeSession?._backendId) return activeSession._backendId;
	if (draftSessionBackendId) return draftSessionBackendId;
	return preferredBackendId;
}

export function useAgentBackend(backendId?: AgentBackendId) {
	const allBackends = useAllAgentBackends();
	const activeBackendId = useActiveAgentBackendId();
	const resolvedBackendId = backendId ?? activeBackendId;
	return allBackends[resolvedBackendId] ?? getCurrentAgentBackend(window.electronAPI, resolvedBackendId);
}

export function useAvailableBackendIds() {
	const allBackends = useAllAgentBackends();
	return AGENT_BACKEND_IDS.filter((backendId) => Boolean(allBackends[backendId]));
}

export function useBackendCapabilities() {
	return useAgentBackend()?.capabilities;
}
