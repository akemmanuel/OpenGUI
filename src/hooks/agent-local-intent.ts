import type { HarnessDescriptor, HarnessTarget } from "@/agents/backend";
import { useEffect, useMemo, useRef, useState } from "react";
import { planDirectoryChangePrompt } from "@/hooks/agent-directory-change-notice";
import { resolveSessionHarnessRoute } from "@/hooks/agent-harness-routing";
import type { SessionMeta } from "@/hooks/agent-state-persistence";
import {
  resolveAgentSendSelection,
  sendCommandToAgent,
  sendPromptToAgent,
} from "@/hooks/agent-send";
import { decidePromptIntentDispatch } from "@/hooks/local-intent-orchestration";
import { createSessionQueueOrchestrator } from "@/hooks/agent-session-queue";
import { createPromptSendStartActions } from "@/hooks/agent-send-state";
import {
  processAfterPartQueueTriggers,
  processBusyToIdleTransitions,
} from "@/hooks/agent-queue-dispatch";
import { decideSessionEntry } from "@/hooks/agent-session-entry";
import { getSessionProjectTarget } from "@/hooks/agent-session-utils";
import type { InternalAgentState, QueueMode, Session } from "@/hooks/agent-state-types";
import { getSessionDraftKey } from "@/lib/session-drafts";
import { generateSessionTitle } from "@/lib/session-namer";
import type { OpenGuiClient } from "@/protocol/client";
import type { SelectedModel } from "@/types/electron";

interface SessionCreationLock {
  current: boolean;
}

interface LocalIntentOptions {
  getState: () => InternalAgentState;
  getResourceRuntime: () => HarnessDescriptor["runtime"] | undefined;
  getCurrentVariant: () => string | undefined;
  getWorkspaceBaseUrl?: (workspaceId?: string | null) => string | undefined;
  sessionsClient: OpenGuiClient["sessions"];
  createSession: (title?: string, directory?: string) => Promise<Session | null>;
  scheduleSessionMessageReconcile: (sessionId: string, projectTarget?: HarnessTarget) => void;
  requestSessionAutoName: (input: {
    sessionId: string;
    sourceText: string;
    session?: Session | null;
    force?: boolean;
  }) => void;
  dispatch: (action: unknown) => void;
  sessionCreatingRef: SessionCreationLock;
}

export interface LocalIntentOrchestrator {
  sendPrompt: (text: string, mode?: QueueMode) => Promise<void>;
  sendCommand: (command: string, args: string) => Promise<void>;
  sendQueuedNow: (sessionId: string, promptId: string) => Promise<void>;
  ensureSession: () => Promise<string | null>;
}

interface LocalIntentHookOptions extends Omit<LocalIntentOptions, "sessionCreatingRef"> {
  state: InternalAgentState;
  refreshSessionMessages: (
    sessionId: string,
    projectTarget?: { directory?: string; workspaceId?: string },
  ) => Promise<unknown>;
}

export interface LocalIntentHookResult extends LocalIntentOrchestrator {
  justIdledMap: Record<string, true>;
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
  options: LocalIntentOptions,
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
      dispatch({ type: "SET_ERROR", payload: "Choose a Harness model before sending." });
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
      });
      scheduleSessionMessageReconcile(sessionId, projectTarget);
    } catch {
      dispatch({ type: "SET_BUSY", payload: false });
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
      dispatch({ type: "SET_ERROR", payload: "Choose a Harness model before sending." });
      return false;
    }
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

  const sendPrompt = async (text: string, mode?: QueueMode) => {
    const initialState = getState();
    if (!initialState.activeSessionId && initialState.activeTargetDirectory) {
      const selection = resolveAgentSendSelection(getSelectionSnapshot());
      if (!selection.model) {
        dispatch({ type: "SET_ERROR", payload: "Choose a Harness model before sending." });
        if (typeof window !== "undefined") {
          window.dispatchEvent(new Event("open-model-selector"));
        }
        return;
      }
    }

    const sessionId = await resolveNamedSession(text);
    if (!sessionId) return;

    const current = getState();
    const intent = decidePromptIntentDispatch({
      sessionId,
      requestedMode: mode,
      busySessionIds: current.busySessionIds,
    });
    if (!intent) return;

    if (intent.type === "queue-after-part" || intent.type === "queue-prompt") {
      const queued = await enqueueSelectedPrompt({
        sessionId: intent.sessionId,
        text,
        mode: intent.mode,
        insertAt: intent.insertAt,
      });
      if (!queued) return;

      if (intent.type === "queue-after-part") {
        dispatch({
          type: "SET_AFTER_PART_PENDING",
          payload: { sessionID: intent.sessionId, pending: true },
        });
        return;
      }

      if (intent.type === "queue-prompt" && intent.mode === "interrupt") {
        const session = getState().sessions.find((item) => item.id === intent.sessionId);
        await sessionsClient.abort({
          sessionId: intent.sessionId,
          harnessId: resolveSessionHarnessRoute(session).harnessId ?? undefined,
          target:
            getSessionProjectTarget(session, current.sessionMeta[intent.sessionId]) ?? undefined,
        });
      }
      return;
    }

    await dispatchPromptDirect(
      intent.sessionId,
      prepareDirectoryChangePrompt(intent.sessionId, text),
      undefined,
      undefined,
      undefined,
      intent.mode,
    );
  };

  const sendCommand = async (command: string, args: string) => {
    const commandText = `/${command}${args ? ` ${args}` : ""}`;
    const sessionId = await resolveNamedSession(commandText);
    if (!sessionId) return;

    const commandRuntime = getResourceRuntime();
    if (!commandRuntime?.sendCommand) return;
    const current = getState();
    if (!current.selectedModel) {
      dispatch({ type: "SET_ERROR", payload: "Choose a Harness model before sending." });
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
    } catch {
      dispatch({ type: "SET_BUSY", payload: false });
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

export function useLocalIntentOrchestration(
  options: LocalIntentHookOptions,
): LocalIntentHookResult {
  const {
    state,
    refreshSessionMessages,
    getState,
    getResourceRuntime,
    getCurrentVariant,
    getWorkspaceBaseUrl,
    sessionsClient,
    createSession,
    scheduleSessionMessageReconcile,
    requestSessionAutoName,
    dispatch,
  } = options;

  const sessionCreatingRef = useRef(false);
  const prevBusyRef = useRef<Set<string>>(new Set());
  const [justIdledMap, setJustIdledMap] = useState<Record<string, true>>({});

  const orchestrator = useMemo(
    () =>
      createLocalIntentOrchestrator({
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
      }),
    [
      createSession,
      dispatch,
      getCurrentVariant,
      getResourceRuntime,
      getState,
      getWorkspaceBaseUrl,
      requestSessionAutoName,
      scheduleSessionMessageReconcile,
      sessionsClient,
    ],
  );

  useEffect(() => {
    const next = processBusyToIdleTransitions({
      previousBusySessionIds: prevBusyRef.current,
      currentBusySessionIds: state.busySessionIds,
      activeSessionId: getState().activeSessionId,
      sessions: getState().sessions,
      sessionMeta: getState().sessionMeta,
      refreshSessionMessages,
    });
    setJustIdledMap((prev) => {
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(next);
      if (prevKeys.length === nextKeys.length && nextKeys.every((key) => prev[key])) return prev;
      return next;
    });
    prevBusyRef.current = new Set(state.busySessionIds);
  }, [state.busySessionIds, getState, refreshSessionMessages]);

  useEffect(() => {
    if (state._afterPartTriggered.size === 0) return;
    processAfterPartQueueTriggers({
      sessionIds: state._afterPartTriggered,
      abortSession: (input) => {
        const session = getState().sessions.find((item) => item.id === input.sessionId);
        return sessionsClient.abort({
          ...input,
          harnessId: resolveSessionHarnessRoute(session).harnessId ?? undefined,
          target:
            getSessionProjectTarget(
              session,
              session ? getState().sessionMeta[session.id] : undefined,
            ) ?? undefined,
        });
      },
      dispatch: dispatch as never,
    });
  }, [state._afterPartTriggered, sessionsClient, getState, dispatch]);

  return { ...orchestrator, justIdledMap };
}
