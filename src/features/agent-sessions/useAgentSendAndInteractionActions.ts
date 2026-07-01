import type { MutableRefObject } from "react";
import { useLocalIntentOrchestration } from "@/features/local-intent";
import { useSessionInteractionOrchestration } from "./useAgentSessionInteractionOrchestration";
import type { Action } from "@/hooks/agent-reducer";
import type { InternalAgentState, Session } from "@/hooks/agent-state-types";
import type { HarnessId } from "@/agents";
import type { OpenGuiClient } from "@/protocol/client";
import type { HarnessDescriptor } from "@/agents/backend";
import { useAgentSessionAutoNaming } from "./useAgentSessionAutoNaming";
import type { SessionTitleTrackingRefs } from "./useAgentSessionTitleOrchestration";

export function useAgentSendAndInteractionActions(input: {
  state: InternalAgentState;
  stateRef: MutableRefObject<InternalAgentState>;
  runtime: HarnessDescriptor["runtime"] | undefined;
  openGuiClient: OpenGuiClient;
  preferredHarnessId: HarnessId;
  currentVariant: string | undefined;
  dispatch: (action: Action) => void;
  createSession: (title?: string, directory?: string) => Promise<Session | null>;
  scheduleSessionMessageReconcile: (
    sessionId: string,
    projectTarget?: { directory?: string; workspaceId?: string },
  ) => void;
  refreshActiveSessionMessages: (
    sessionId: string,
    projectTarget?: { directory?: string; workspaceId?: string },
  ) => Promise<boolean> | boolean;
  resolveCurrentSessionId: (sessionId: string) => string;
  reloadActiveTranscript: (sessionId: string) => Promise<boolean>;
  titleTracking: SessionTitleTrackingRefs;
  applyGeneratedSessionTitle: (sessionId: string, requestId: number, title: string) => void;
}) {
  const {
    state,
    stateRef,
    runtime,
    openGuiClient,
    preferredHarnessId,
    currentVariant,
    dispatch,
    createSession,
    scheduleSessionMessageReconcile,
    refreshActiveSessionMessages,
    resolveCurrentSessionId,
    reloadActiveTranscript,
    titleTracking,
    applyGeneratedSessionTitle,
  } = input;

  const requestSessionAutoName = useAgentSessionAutoNaming({
    dispatch,
    tracking: titleTracking,
    applyGeneratedSessionTitle,
  });

  const { sendPrompt, sendCommand, sendQueuedNow, ensureSession, justIdledMap } =
    useLocalIntentOrchestration({
      state,
      getState: () => stateRef.current,
      getResourceRuntime: () => runtime,
      getCurrentVariant: () => currentVariant,
      getWorkspaceBaseUrl: (workspaceId) => {
        const workspace = stateRef.current.workspaces.find((item) => item.id === workspaceId);
        return workspace && !workspace.isLocal ? workspace.serverUrl : undefined;
      },
      sessionsClient: openGuiClient.sessions,
      createSession,
      scheduleSessionMessageReconcile,
      requestSessionAutoName,
      dispatch: (action) => dispatch(action as never),
      refreshSessionMessages: (sessionId, projectTarget) =>
        Promise.resolve(refreshActiveSessionMessages(sessionId, projectTarget)),
      getFallbackHarnessId: () => preferredHarnessId,
    });

  const interactions = useSessionInteractionOrchestration({
    state,
    stateRef,
    runtime,
    openGuiClient,
    ensureSession,
    resolveCurrentSessionId,
    dispatch,
    reloadActiveTranscript,
  });

  return {
    sendPrompt,
    sendCommand,
    sendQueuedNow,
    ensureSession,
    justIdledMap,
    ...interactions,
  };
}
