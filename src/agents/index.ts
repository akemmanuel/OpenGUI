import { createBackendIdCodec } from "./shared.ts";

export type HarnessId = "opencode" | "claude-code" | "pi" | "codex";

export const HARNESS_IDS: HarnessId[] = ["opencode", "claude-code", "pi", "codex"];

export const HARNESS_LABELS: Record<HarnessId, string> = {
  opencode: "OpenCode",
  "claude-code": "Claude",
  pi: "Pi",
  codex: "Codex",
};

export { createBackendIdCodec as createHarnessIdCodec } from "./shared.ts";

const HARNESS_ID_CODECS = Object.fromEntries(
  HARNESS_IDS.map((harnessId) => [harnessId, createBackendIdCodec(harnessId)]),
) as Record<HarnessId, ReturnType<typeof createBackendIdCodec>>;

export function getHarnessIdFromSessionId(sessionId: string | null | undefined): HarnessId | null {
  return HARNESS_IDS.find((harnessId) => HARNESS_ID_CODECS[harnessId].matches(sessionId)) ?? null;
}

/** @deprecated Use HarnessId. Kept as a compatibility alias while protocol fields migrate. */
export type AgentBackendId = HarnessId;
/** @deprecated Use HARNESS_IDS. */
export const AGENT_BACKEND_IDS = HARNESS_IDS;
/** @deprecated Use HARNESS_LABELS. */
export const AGENT_BACKEND_LABELS = HARNESS_LABELS;
/** @deprecated Use createHarnessIdCodec. */
export { createBackendIdCodec as createAgentIdCodec } from "./shared.ts";
/** @deprecated Use getHarnessIdFromSessionId. */
export const getAgentBackendIdFromSessionId = getHarnessIdFromSessionId;
