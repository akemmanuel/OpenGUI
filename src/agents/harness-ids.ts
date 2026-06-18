/**
 * Re-exports harness ids from `@opengui/protocol` for Frontend/agents.
 * Session-identity codecs still import from here to avoid cycles.
 */
export {
  DEFAULT_HARNESS_ID,
  HARNESS_ID_VALUES,
  isHarnessIdValue,
  type HarnessId,
} from "@opengui/protocol";
