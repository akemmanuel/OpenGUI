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
