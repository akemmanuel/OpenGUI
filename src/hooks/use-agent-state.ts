export {
  HarnessProvider,
  LOCAL_WORKSPACE_ID,
  NOTIFICATIONS_ENABLED_KEY,
  resolveServerDefaultModel,
} from "./use-agent-impl-core";
export {
  useActions,
  useConnectionState,
  useMessages,
  useModelState,
  useSessionState,
} from "@/features/agent-provider-shell";

export type {
  HarnessState,
  MessageEntry,
  QueueMode,
  QueuedPrompt,
  Session,
} from "./agent-state-types";

export type { SessionColor } from "./agent-state-persistence";
