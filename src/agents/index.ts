import { createBackendIdCodec } from "./shared.ts";

export type HarnessId = "opencode" | "claude-code" | "pi" | "codex";

export type ActiveHarnessId = HarnessId;

export const HARNESS_IDS: ActiveHarnessId[] = ["opencode", "claude-code", "pi", "codex"];
export const DEFAULT_HARNESS_ID: ActiveHarnessId = "claude-code";

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

export const HARNESS_LABELS_BY_ID = HARNESS_LABELS;
