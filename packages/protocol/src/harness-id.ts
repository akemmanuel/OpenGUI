/** Harness id constants — leaf module (no app imports). Keep aligned with `src/agents/harness-ids.ts`. */
export const HARNESS_ID_VALUES = ["opencode", "claude-code", "pi", "codex", "grok-build"] as const;

export type HarnessId = (typeof HARNESS_ID_VALUES)[number];

export const DEFAULT_HARNESS_ID: HarnessId = "claude-code";

export function isHarnessIdValue(value: string): value is HarnessId {
  return (HARNESS_ID_VALUES as readonly string[]).includes(value);
}
