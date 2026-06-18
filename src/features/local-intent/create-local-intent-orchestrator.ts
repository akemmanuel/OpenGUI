import type { HarnessId } from "@/agents";
import { planDirectoryChangePrompt } from "@/hooks/agent-directory-change-notice";
import type { SessionMeta } from "@/hooks/agent-state-persistence";
import {
  resolveAgentSendSelection,
  sendCommandToAgent,
  sendPromptToAgent,
} from "@/hooks/agent-send";
import {
  createAbortSessionViaClient,
  executeLocalIntentSendPrompt,
} from "@/hooks/local-intent-send-prompt";
import { createSessionQueueOrchestrator } from "@/hooks/agent-session-queue";
import { createPromptSendStartActions } from "@/hooks/agent-send-state";
import { decideSessionEntry } from "@/hooks/agent-session-entry";
import type { InternalAgentState, QueueMode } from "@/hooks/agent-state-types";
import { getErrorMessage } from "@/lib/utils";
import { getSessionDraftKey } from "@/lib/session-drafts";
import { generateSessionTitle } from "@/lib/session-namer";
import type { SelectedModel } from "@/types/electron";
import { i18n } from "@/i18n";
import {
  hasPromptBoxSelectionForSend,
  openPromptBoxSelectionDialog,
} from "@/hooks/prompt-box-selection";

import type { CreateLocalIntentOrchestratorInput, LocalIntentOrchestrator } from "./types";

function promptBoxSelectionIncompleteMessage() {
  return i18n.t("prompt.chooseHarnessAndModelBeforeSend");
}

function notifyPromptBoxSelectionIncomplete(
  dispatch: CreateLocalIntentOrchestratorInput["dispatch"],
) {
  dispatch({ type: "SET_ERROR", payload: promptBoxSelectionIncompleteMessage() });
  openPromptBoxSelectionDialog();
}

function isPromptBoxReadyForSend(
  state: InternalAgentState,
  getFallbackHarnessId: () => HarnessId,
): boolean {
  const activeSession = state.activeSessionId
    ? (state.sessions.find((session) => session.id === state.activeSessionId) ?? null)
    : null;
  return hasPromptBoxSelectionForSend({
    activeSession,
    activeTargetHarnessId: state.activeTargetHarnessId,
    fallbackHarnessId: getFallbackHarnessId(),
    selectedModel: state.selectedModel,
  });
}

function applySessionMetaPatch(
  current: SessionMeta | undefined,
  patch: Partial<SessionMeta>,
): SessionMeta {
  return {
    ...current,
    ...patch,
  };
}

export function createLocalIntentOrchestrator(
  options: CreateLocalIntentOrchestratorInput,
): LocalIntentOrchestrator {
  const {
    getState,
    getResourceRuntime,
    getCurrentVariant,
    getWorkspaceBaseUrl,
    sessionsClient,
    createSession,
    scheduleSessionMessageReconcile,
    requestSessionAutoName,
    dispatch,
    sessionCreatingRef,
    getFallbackHarnessId,
  } = options;

  const prepareDirectoryChangePrompt = (sessionId: string, text: string) => {
    const state = getState();
    const meta = state.sessionMeta[sessionId];
    const session = state.sessions.find((item) => item.id === sessionId);
    const plan = planDirectoryChangePrompt({ text, session, meta });
    if (!plan.metaPatch) return plan.text;

    dispatch({
      type: "SET_SESSION_META",
      payload: {
        sessionId,
        meta: applySessionMetaPatch(meta, plan.metaPatch),
      },
    });

    return plan.text;
  };

  const createSessionFromActiveTarget = async (sourceText: string): Promise<string | null> => {
    const state = getState();
    const directory = state.activeTargetDirectory;
    if (!directory) {
      dispatch({
        type: "SET_ERROR",
        payload: "Select or create a session first.",
      });
      return null;
    }
    if (sessionCreatingRef.current) return null;

    sessionCreatingRef.current = true;
    try {
      const title = await generateSessionTitle(sourceText);
      const newSession = await createSession(title, directory);
      if (!newSession) return null;

      const draftKey = getSessionDraftKey({
        workspaceId: state.activeWorkspaceId,
        directory,
      });
      if (draftKey) {
        dispatch({ type: "CLEAR_SESSION_DRAFT", payload: draftKey });
      }
      dispatch({ type: "CLEAR_ACTIVE_TARGET" });
      return newSession.id;
    } finally {
      sessionCreatingRef.current = false;
    }
  };

  const resolveSessionEntry = async (sourceText?: string): Promise<string | null> => {
    const state = getState();
    const decision = decideSessionEntry({
      activeSessionId: state.activeSessionId,
    });

    if (decision.type === "use-active-session") return decision.sessionId;
    if (state.activeTargetDirectory && sourceText != null) {
      return await createSessionFromActiveTarget(sourceText);
    }

    dispatch({
      type: "SET_ERROR",
      payload: "Select or create a session first.",
    });
    return null;
  };

  const ensureSession = async (): Promise<string | null> => {
    return await resolveSessionEntry();
  };

  const dispatchPromptDirect = async (
    sessionId: string,
    text: string,
    overrideModel?: SelectedModel,
    overrideAgent?: string,
    overrideVariant?: string,
    mode?: QueueMode,
  ) => {
    const state = getState();
    const selection = resolveAgentSendSelection(
      {
        selectedModel: state.selectedModel,
        selectedAgent: state.selectedAgent,
        variantSelections: state.variantSelections,
        agents: state.agents,
      },
      {
        model: overrideModel,
        agent: overrideAgent,
        variant: overrideVariant,
      },
    );
    if (!selection.model) {
      notifyPromptBoxSelectionIncomplete(dispatch);
      return;
    }
    for (const action of createPromptSendStartActions({ sessionId, text, selection })) {
      dispatch(action);
    }

    try {
      const currentState = getState();
      const currentSession = currentState.sessions.find((session) => session.id === sessionId);
      const { projectTarget } = await sendPromptToAgent({
        sessions: sessionsClient,
        session: currentSession,
        sessionMeta: currentSession ? currentState.sessionMeta[currentSession.id] : undefined,
        sessionId,
        text,
        selection,
        activeWorkspaceId: currentState.activeWorkspaceId,
        getWorkspaceBaseUrl,
        mode,
        activeTargetHarnessId: currentState.activeTargetHarnessId,
        fallbackHarnessId: getFallbackHarnessId(),
      });
      scheduleSessionMessageReconcile(sessionId, projectTarget);
    } catch (error) {
      dispatch({ type: "SET_BUSY", payload: false });
      dispatch({
        type: "SESSION_STATUS",
        payload: { sessionID: sessionId, status: { type: "idle" } },
      });
      dispatch({ type: "SET_ERROR", payload: getErrorMessage(error, "Failed to send prompt") });
    }
  };

  const sessionQueue = createSessionQueueOrchestrator({
    getState,
    sessionsClient,
    dispatch,
  });

  const getSelectionSnapshot = () => {
    const state = getState();
    return {
      selectedModel: state.selectedModel,
      selectedAgent: state.selectedAgent,
      variantSelections: state.variantSelections,
      agents: state.agents,
    };
  };

  const enqueueSelectedPrompt = async (input: {
    sessionId: string;
    text: string;
    mode: QueueMode;
    insertAt: "front" | "back";
  }) => {
    const selection = resolveAgentSendSelection(getSelectionSnapshot());
    if (!selection.model) {
      notifyPromptBoxSelectionIncomplete(dispatch);
      return false;
    }
    try {
      await sessionQueue.enqueuePrompt({
        sessionId: input.sessionId,
        text: prepareDirectoryChangePrompt(input.sessionId, input.text),
        model: selection.model,
        agent: selection.agent,
        variant: selection.variant,
        mode: input.mode,
        insertAt: input.insertAt,
      });
      return true;
    } catch (error) {
      dispatch({
        type: "SET_ERROR",
        payload: getErrorMessage(error, "Failed to queue prompt"),
      });
      return false;
    }
  };

  const resolveNamedSession = async (sourceText: string): Promise<string | null> => {
    const hadActiveSession = Boolean(getState().activeSessionId);
    const sessionId = await resolveSessionEntry(sourceText);
    if (!sessionId) return null;

    if (hadActiveSession) {
      requestSessionAutoName({
        sessionId,
        sourceText,
        session: getState().sessions.find((session) => session.id === sessionId),
      });
    }
    return sessionId;
  };

  const abortSession = createAbortSessionViaClient(sessionsClient);

  const sendPrompt = async (text: string, mode?: QueueMode) => {
    const state = getState();
    if (!isPromptBoxReadyForSend(state, getFallbackHarnessId)) {
      notifyPromptBoxSelectionIncomplete(dispatch);
      return;
    }
    await executeLocalIntentSendPrompt({
      text,
      mode,
      activeSessionId: state.activeSessionId,
      activeTargetDirectory: state.activeTargetDirectory,
      busySessionIds: state.busySessionIds,
      sessions: state.sessions,
      sessionMeta: state.sessionMeta,
      dispatch,
      resolveSessionId: resolveNamedSession,
      ensureModelSelectedForNewChat: () => {
        if (isPromptBoxReadyForSend(getState(), getFallbackHarnessId)) return true;
        notifyPromptBoxSelectionIncomplete(dispatch);
        return false;
      },
      preparePromptText: prepareDirectoryChangePrompt,
      enqueuePrompt: enqueueSelectedPrompt,
      dispatchPromptNow: (sessionId, preparedText, promptMode) =>
        dispatchPromptDirect(sessionId, preparedText, undefined, undefined, undefined, promptMode),
      abortSession,
    });
  };

  const sendCommand = async (command: string, args: string) => {
    const commandText = `/${command}${args ? ` ${args}` : ""}`;
    const sessionId = await resolveNamedSession(commandText);
    if (!sessionId) return;

    const commandRuntime = getResourceRuntime();
    if (!commandRuntime?.sendCommand) return;
    const current = getState();
    if (!isPromptBoxReadyForSend(current, getFallbackHarnessId)) {
      notifyPromptBoxSelectionIncomplete(dispatch);
      return;
    }

    dispatch({ type: "SET_BUSY", payload: true });
    try {
      const latestSession = getState().sessions.find((session) => session.id === sessionId);
      const { projectTarget } = await sendCommandToAgent({
        runtime: commandRuntime,
        session: latestSession,
        sessionMeta: latestSession ? getState().sessionMeta[latestSession.id] : undefined,
        sessionId,
        command,
        args,
        selection: {
          model: current.selectedModel ?? undefined,
          agent: current.selectedAgent ?? undefined,
          variant: getCurrentVariant(),
        },
      });
      scheduleSessionMessageReconcile(sessionId, projectTarget);
    } catch (error) {
      dispatch({ type: "SET_BUSY", payload: false });
      dispatch({ type: "SET_ERROR", payload: getErrorMessage(error, "Failed to send command") });
    }
  };

  const sendQueuedNow = sessionQueue.sendNow;

  return {
    sendPrompt,
    sendCommand,
    sendQueuedNow,
    ensureSession,
  };
}
