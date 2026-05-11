import type { ElectronAPI } from "@/types/electron";
import { createClaudeCodeBackend } from "./claude-code";
import { createCodexBackend } from "./codex";
import { createOpenCodeBackend } from "./opencode";
import { createPiBackend } from "./pi";
import { createBackendIdCodec } from "./shared";

export type AgentBackendId = "opencode" | "claude-code" | "pi" | "codex";

export const AGENT_BACKEND_IDS: AgentBackendId[] = ["opencode", "claude-code", "pi", "codex"];

export const AGENT_BACKEND_LABELS: Record<AgentBackendId, string> = {
  opencode: "OpenCode",
  "claude-code": "Claude",
  pi: "Pi",
  codex: "Codex",
};

export { createBackendIdCodec as createAgentIdCodec } from "./shared";

const AGENT_ID_CODECS = Object.fromEntries(
  AGENT_BACKEND_IDS.map((backendId) => [backendId, createBackendIdCodec(backendId)]),
) as Record<AgentBackendId, ReturnType<typeof createBackendIdCodec>>;

export function getAgentBackendIdFromSessionId(
  sessionId: string | null | undefined,
): AgentBackendId | null {
  return (
    AGENT_BACKEND_IDS.find((backendId) => AGENT_ID_CODECS[backendId].matches(sessionId)) ?? null
  );
}

export function getCurrentAgentBackend(
  electronAPI?: ElectronAPI,
  backendId: AgentBackendId = "opencode",
) {
  if (backendId === "claude-code") {
    return createClaudeCodeBackend(electronAPI?.claudeCode);
  }
  if (backendId === "pi") {
    return createPiBackend(electronAPI?.pi);
  }
  if (backendId === "codex") {
    return createCodexBackend(electronAPI?.codex);
  }
  return createOpenCodeBackend(electronAPI?.opencode);
}

export function getAllAgentBackends(electronAPI?: ElectronAPI) {
  return AGENT_BACKEND_IDS.map((backendId) =>
    getCurrentAgentBackend(electronAPI, backendId),
  ).filter((backend): backend is NonNullable<ReturnType<typeof getCurrentAgentBackend>> =>
    Boolean(backend),
  );
}
