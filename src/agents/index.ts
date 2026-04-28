import type { ElectronAPI } from "@/types/electron"
import { createClaudeCodeBackend } from "./claude-code"
import { createCodexBackend } from "./codex"
import { createOpenCodeBackend } from "./opencode"
import { createPiBackend } from "./pi"

export type AgentBackendId = "opencode" | "claude-code" | "pi" | "codex"

export function getCurrentAgentBackend(
	electronAPI?: ElectronAPI,
	backendId: AgentBackendId = "opencode",
) {
	if (backendId === "claude-code") {
		return createClaudeCodeBackend(electronAPI?.claudeCode)
	}
	if (backendId === "pi") {
		return createPiBackend(electronAPI?.pi)
	}
	if (backendId === "codex") {
		return createCodexBackend(electronAPI?.codex)
	}
	return createOpenCodeBackend(electronAPI?.opencode)
}
