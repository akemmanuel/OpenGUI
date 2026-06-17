import { createHarnessIdCodec } from "./shared.ts";
import type { HarnessId } from "./harness-ids.ts";
import { HARNESS_IDS, HARNESS_LABELS } from "./harness-registry.ts";

export type { HarnessId } from "./harness-ids.ts";
export { DEFAULT_HARNESS_ID, HARNESS_ID_VALUES, isHarnessIdValue } from "./harness-ids.ts";
export {
  HARNESS_REGISTRY,
  HARNESS_IDS,
  HARNESS_LABELS,
  CLI_COMMAND_BY_HARNESS,
  type HarnessRegistryEntry,
} from "./harness-registry.ts";

export type ActiveHarnessId = HarnessId;

export { createHarnessIdCodec } from "./shared.ts";

const HARNESS_ID_CODECS = Object.fromEntries(
  HARNESS_IDS.map((harnessId) => [harnessId, createHarnessIdCodec(harnessId)]),
) as Record<HarnessId, ReturnType<typeof createHarnessIdCodec>>;

export function getHarnessIdFromSessionId(sessionId: string | null | undefined): HarnessId | null {
  return HARNESS_IDS.find((harnessId) => HARNESS_ID_CODECS[harnessId].matches(sessionId)) ?? null;
}

export const HARNESS_LABELS_BY_ID = HARNESS_LABELS;
