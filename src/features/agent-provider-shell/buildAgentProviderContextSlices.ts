import { useMemo } from "react";
import type {
  ActionsContextValue,
  ConnectionContextValue,
  MessagesContextValue,
  ModelContextValue,
  SessionContextValue,
} from "@/hooks/agent-contexts";
import type { InternalAgentState, Session } from "@/hooks/agent-state-types";

export function buildSessionContextSlice(input: {
  state: InternalAgentState;
  activeWorkspaceSessions: Session[];
}): SessionContextValue {
  const { state, activeWorkspaceSessions } = input;
  return {
    sessions: activeWorkspaceSessions,
    activeSessionId:
      state.activeSessionId &&
      activeWorkspaceSessions.some((session) => session.id === state.activeSessionId)
        ? state.activeSessionId
        : null,
    isBusy: state.isBusy,
    busySessionIds: state.busySessionIds,
    queuedPrompts: state.queuedPrompts,
    pendingPermissions: state.pendingPermissions,
    pendingQuestions: state.pendingQuestions,
    activeTargetDirectory: state.activeTargetDirectory,
    activeTargetHarnessId: state.activeTargetHarnessId,
    namingSessionIds: state.namingSessionIds,
    unreadSessionIds: state.unreadSessionIds,
    sessionDrafts: state.sessionDrafts,
    sessionMeta: state.sessionMeta,
    sessionErrors: state.sessionErrors,
  };
}

export function buildMessagesContextSlice(state: InternalAgentState): MessagesContextValue {
  return {
    turnRuns: state.activeSessionId
      ? Object.fromEntries(
          Object.entries(state.turnRuns).filter(
            ([, run]) => run.sessionID === state.activeSessionId,
          ),
        )
      : {},
  };
}

export function buildModelContextSlice(input: {
  state: InternalAgentState;
  currentVariant: string | undefined;
}): ModelContextValue {
  const { state, currentVariant } = input;
  return {
    providers: state.providers,
    providerDefaults: state.providerDefaults,
    selectedModel: state.selectedModel,
    agents: state.agents,
    selectedAgent: state.selectedAgent,
    variantSelections: state.variantSelections,
    commands: state.commands,
    currentVariant,
  };
}

export function useAgentProviderContextSlices(input: {
  state: InternalAgentState;
  activeWorkspaceSessions: Session[];
  currentVariant: string | undefined;
  connectionContextSlice: ConnectionContextValue;
  actions: ActionsContextValue;
}) {
  const { state, activeWorkspaceSessions, currentVariant, connectionContextSlice, actions } = input;

  const sessionCtx = useMemo(
    () => buildSessionContextSlice({ state, activeWorkspaceSessions }),
    [
      activeWorkspaceSessions,
      state.activeSessionId,
      state.isBusy,
      state.busySessionIds,
      state.queuedPrompts,
      state.pendingPermissions,
      state.pendingQuestions,
      state.activeTargetDirectory,
      state.activeTargetHarnessId,
      state.namingSessionIds,
      state.unreadSessionIds,
      state.sessionDrafts,
      state.sessionMeta,
      state.sessionErrors,
    ],
  );

  const messagesCtx = useMemo(
    () => buildMessagesContextSlice(state),
    [state.activeSessionId, state.turnRuns],
  );

  const modelCtx = useMemo(
    () => buildModelContextSlice({ state, currentVariant }),
    [
      state.providers,
      state.providerDefaults,
      state.selectedModel,
      state.agents,
      state.selectedAgent,
      state.variantSelections,
      state.commands,
      currentVariant,
    ],
  );

  const connectionCtx = connectionContextSlice;
  const actionsCtx = actions;

  return { sessionCtx, messagesCtx, modelCtx, connectionCtx, actionsCtx };
}
