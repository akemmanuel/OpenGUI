import type { ElectronAPI } from "@/types/electron";
import { createClaudeCodeBackend } from "./claude-code";
import { createOpenCodeBackend } from "./opencode";

export type AgentBackendId = "opencode" | "claude-code";

export function getCurrentAgentBackend(
	electronAPI?: ElectronAPI,
	backendId: AgentBackendId = "opencode",
) {
	if (backendId === "claude-code") {
		return createClaudeCodeBackend(electronAPI?.claudeCode);
	}
	return createOpenCodeBackend(electronAPI?.opencode);
}
