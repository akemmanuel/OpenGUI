import { useContext } from "react";
import {
  ActionsContext,
  type ActionsContextValue,
  ModelContext,
  type ModelContextValue,
  SessionContext,
  type SessionContextValue,
  WorkspaceContext,
  type WorkspaceContextValue,
} from "./agent-contexts";

export { LOCAL_WORKSPACE_ID, NOTIFICATIONS_ENABLED_KEY } from "@/lib/persistence/workspace";
export { resolveServerDefaultModel } from "./agent-model-selection";

export function useSessionState(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSessionState must be used within provider");
  return context;
}

export function useModelState(): ModelContextValue {
  const context = useContext(ModelContext);
  if (!context) throw new Error("useModelState must be used within provider");
  return context;
}

export function useWorkspaceState(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("useWorkspaceState must be used within provider");
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

export type { SessionColor } from "@/lib/persistence/session";
