import type { ReactNode } from "react";
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

export function AgentProviderShell({
  children,
  sessionCtx,
  messagesCtx,
  modelCtx,
  connectionCtx,
  actionsCtx,
}: {
  children: ReactNode;
  sessionCtx: SessionContextValue;
  messagesCtx: MessagesContextValue;
  modelCtx: ModelContextValue;
  connectionCtx: ConnectionContextValue;
  actionsCtx: ActionsContextValue;
}) {
  return (
    <ActionsContext.Provider value={actionsCtx}>
      <ConnectionContext.Provider value={connectionCtx}>
        <ModelContext.Provider value={modelCtx}>
          <SessionContext.Provider value={sessionCtx}>
            <MessagesContext.Provider value={messagesCtx}>{children}</MessagesContext.Provider>
          </SessionContext.Provider>
        </ModelContext.Provider>
      </ConnectionContext.Provider>
    </ActionsContext.Provider>
  );
}
