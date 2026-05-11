export {
  AgentBackendProvider,
  LOCAL_WORKSPACE_ID,
  NOTIFICATIONS_ENABLED_KEY,
  resolveServerDefaultModel,
  useActions,
  useConnectionState,
  useMessages,
  useModelState,
  useSessionState,
} from "./use-agent-impl-core";

export type {
  AgentBackendState,
  MessageEntry,
  QueueMode,
  QueuedPrompt,
  Session,
} from "./agent-state-types";

export type { SessionColor } from "./agent-state-persistence";
