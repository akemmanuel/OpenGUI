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
} from "@/hooks/agent-contexts";

export function useSessionState(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error("useSessionState must be used within provider");
  }
  return ctx;
}

export function useMessages(): MessagesContextValue {
  const ctx = useContext(MessagesContext);
  if (!ctx) {
    throw new Error("useMessages must be used within provider");
  }
  return ctx;
}

export function useModelState(): ModelContextValue {
  const ctx = useContext(ModelContext);
  if (!ctx) {
    throw new Error("useModelState must be used within provider");
  }
  return ctx;
}

export function useConnectionState(): ConnectionContextValue {
  const ctx = useContext(ConnectionContext);
  if (!ctx) {
    throw new Error("useConnectionState must be used within provider");
  }
  return ctx;
}

export function useActions(): ActionsContextValue {
  const ctx = useContext(ActionsContext);
  if (!ctx) {
    throw new Error("useActions must be used within provider");
  }
  return ctx;
}
