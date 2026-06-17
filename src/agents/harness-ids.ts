/**
 * Leaf module: harness id constants only. No imports from codecs or session-identity
 * (avoids Rollup init cycles). Other modules derive lists from here.
 */
export const HARNESS_ID_VALUES = ["opencode", "claude-code", "pi", "codex"] as const;

export type HarnessId = (typeof HARNESS_ID_VALUES)[number];

export const DEFAULT_HARNESS_ID: HarnessId = "claude-code";

export function isHarnessIdValue(value: string): value is HarnessId {
  return (HARNESS_ID_VALUES as readonly string[]).includes(value);
}
