import type { ElectronAPI } from "@/types/electron"
import { createClaudeCodeBackend } from "./claude-code"
import { createCodexBackend } from "./codex"
import { createOpenCodeBackend } from "./opencode"
import { createPiBackend } from "./pi"

export type AgentBackendId = "opencode" | "claude-code" | "pi" | "codex"

export const AGENT_BACKEND_IDS: AgentBackendId[] = [
	"opencode",
	"claude-code",
	"pi",
	"codex",
]

export const AGENT_BACKEND_LABELS: Record<AgentBackendId, string> = {
	opencode: "OpenCode",
	"claude-code": "Claude",
	pi: "Pi",
	codex: "Codex",
}

export function getAgentBackendIdFromSessionId(
	sessionId: string | null | undefined,
): AgentBackendId | null {
	if (!sessionId) return null
	if (sessionId.startsWith("opencode:")) return "opencode"
	if (sessionId.startsWith("claude-code:")) return "claude-code"
	if (sessionId.startsWith("pi:")) return "pi"
	if (sessionId.startsWith("codex:")) return "codex"
	return null
}

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

export function getAllAgentBackends(electronAPI?: ElectronAPI) {
	return AGENT_BACKEND_IDS.map((backendId) =>
		getCurrentAgentBackend(electronAPI, backendId),
	).filter(
		(
			backend,
		): backend is NonNullable<ReturnType<typeof getCurrentAgentBackend>> =>
			Boolean(backend),
	)
}
