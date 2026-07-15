import { useContext } from "react";
import {
  ActionsContext,
  type ActionsContextValue,
  ConnectionContext,
  type ConnectionContextValue,
  MessagesContext,
  type MessagesContextValue,
  ModelContext,
  type ModelContextValue,
  SessionContext,
  type SessionContextValue,
} from "./agent-contexts";

export { LOCAL_WORKSPACE_ID, NOTIFICATIONS_ENABLED_KEY } from "./agent-state-persistence";
export { resolveServerDefaultModel } from "./agent-model-selection";

export function useSessionState(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSessionState must be used within provider");
  return context;
}

export function useMessages(): MessagesContextValue {
  const context = useContext(MessagesContext);
  if (!context) throw new Error("useMessages must be used within provider");
  return context;
}

export function useModelState(): ModelContextValue {
  const context = useContext(ModelContext);
  if (!context) throw new Error("useModelState must be used within provider");
  return context;
}

export function useConnectionState(): ConnectionContextValue {
  const context = useContext(ConnectionContext);
  if (!context) throw new Error("useConnectionState must be used within provider");
  return context;
}

export function useActions(): ActionsContextValue {
  const context = useContext(ActionsContext);
  if (!context) throw new Error("useActions must be used within provider");
  return context;
}

export type {
  AgentState,
  MessageEntry,
  QueueMode,
  QueuedPrompt,
  Session,
} from "./agent-state-types";

export type { SessionColor } from "./agent-state-persistence";
