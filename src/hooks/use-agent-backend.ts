import { useEffect, useMemo, useState } from "react";
import type { AgentBackendId } from "@/agents";
import { getCurrentAgentBackend } from "@/agents";
import { STORAGE_KEYS } from "@/lib/constants";
import { onSettingsChange, storageGet, storageSet } from "@/lib/safe-storage";

export function getStoredAgentBackendId(): AgentBackendId {
	const stored = storageGet(STORAGE_KEYS.AGENT_BACKEND);
	return stored === "claude-code" ? "claude-code" : "opencode";
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
			setBackendId(change.value === "claude-code" ? "claude-code" : "opencode");
		});
	}, []);

	return backendId;
}

export function useAgentBackend() {
	const backendId = useCurrentAgentBackendId();
	return useMemo(
		() => getCurrentAgentBackend(window.electronAPI, backendId),
		[backendId],
	);
}

export function useBackendCapabilities() {
	return useAgentBackend()?.capabilities;
}
