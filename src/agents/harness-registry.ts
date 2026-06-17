import type { HarnessId } from "./harness-ids.ts";
import { HARNESS_ID_VALUES } from "./harness-ids.ts";

export type HarnessRegistryEntry = {
  readonly id: HarnessId;
  readonly label: string;
  /** CLI binary name for inventory / PATH probes */
  readonly cliCommand: string;
};

export const HARNESS_REGISTRY: readonly HarnessRegistryEntry[] = [
  { id: "opencode", label: "OpenCode", cliCommand: "opencode" },
  { id: "claude-code", label: "Claude", cliCommand: "claude" },
  { id: "pi", label: "Pi", cliCommand: "pi" },
  { id: "codex", label: "Codex", cliCommand: "codex" },
  { id: "grok-build", label: "Grok Build", cliCommand: "grok" },
] as const;

function assertRegistryMatchesIds() {
  const registryIds = HARNESS_REGISTRY.map((e) => e.id)
    .sort()
    .join(",");
  const constIds = [...HARNESS_ID_VALUES].sort().join(",");
  if (registryIds !== constIds) {
    throw new Error(`HARNESS_REGISTRY ids must match HARNESS_ID_VALUES (${constIds})`);
  }
}
assertRegistryMatchesIds();

export const HARNESS_IDS: HarnessId[] = [...HARNESS_ID_VALUES];

export const HARNESS_LABELS: Record<HarnessId, string> = Object.fromEntries(
  HARNESS_REGISTRY.map((e) => [e.id, e.label]),
) as Record<HarnessId, string>;

export const CLI_COMMAND_BY_HARNESS: Record<HarnessId, string> = Object.fromEntries(
  HARNESS_REGISTRY.map((e) => [e.id, e.cliCommand]),
) as Record<HarnessId, string>;
