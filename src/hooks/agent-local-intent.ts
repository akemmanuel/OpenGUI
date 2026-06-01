import type { AgentBackendId } from "@/agents";
import type { AgentBackendDescriptor, AgentBackendTarget } from "@/agents/backend";
import type { SessionMeta } from "@/hooks/agent-state-persistence";
import {
  resolveAgentSendSelection,
  sendCommandToAgent,
  sendPromptToAgent,
  startDraftSessionAgentSend,
} from "@/hooks/agent-send";
import { createSessionQueueOrchestrator } from "@/hooks/agent-session-queue";
import { createDraftSessionSendState, createPromptSendState } from "@/hooks/agent-send-state";
import { decidePromptDispatch } from "@/hooks/agent-prompt-routing";
import { decideSessionEntry } from "@/hooks/agent-session-entry";
import type { InternalAgentState, QueueMode, Session } from "@/hooks/agent-state-types";
import { getErrorMessage, normalizeProjectPath } from "@/lib/utils";
import type { OpenGuiClient } from "@/protocol/client";
import type { SelectedModel } from "@/types/electron";

interface DraftCreationLock {
  current: boolean;
}

interface LocalIntentOptions {
  getState: () => InternalAgentState;
  getCreationBackendId: () => AgentBackendId;
  getCreationRuntime: () => AgentBackendDescriptor["runtime"] | undefined;
  getResourceRuntime: () => AgentBackendDescriptor["runtime"] | undefined;
  getCurrentVariant: () => string | undefined;
  getWorkspaceBaseUrl?: (workspaceId?: string | null) => string | undefined;
  sessionsClient: OpenGuiClient["sessions"];
  ensureDirectoryConnection: (
    directory: string,
    options?: { backendIds?: AgentBackendId[] },
  ) => Promise<void>;
  createSession: (title?: string, directory?: string) => Promise<Session | null>;
  selectSession: (sessionId: string, options?: { session?: Session }) => Promise<void>;
  scheduleSessionMessageReconcile: (sessionId: string, projectTarget?: AgentBackendTarget) => void;
  requestSessionAutoName: (input: {
    sessionId: string;
    sourceText: string;
    session?: Session | null;
    force?: boolean;
  }) => void;
  isChatDirectory: (directory?: string | null) => boolean;
  dispatch: (action: unknown) => void;
  dispatchingSessionIds: Set<string>;
  draftCreatingRef: DraftCreationLock;
}

export interface LocalIntentOrchestrator {
  sendPrompt: (text: string, images?: string[], mode?: QueueMode) => Promise<void>;
  sendCommand: (command: string, args: string) => Promise<void>;
  dispatchNextQueued: (sessionId: string) => Promise<void>;
  sendQueuedNow: (sessionId: string, promptId: string) => Promise<void>;
  ensureSessionFromDraft: () => Promise<string | null>;
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
    getCreationBackendId,
    getCreationRuntime,
    getResourceRuntime,
    getCurrentVariant,
    getWorkspaceBaseUrl,
    sessionsClient,
    ensureDirectoryConnection,
    createSession,
    selectSession,
    scheduleSessionMessageReconcile,
    requestSessionAutoName,
    isChatDirectory,
    dispatch,
    dispatchingSessionIds,
    draftCreatingRef,
  } = options;

  const prepareDirectoryChangePrompt = (sessionId: string, text: string) => {
    const state = getState();
    const meta = state.sessionMeta[sessionId];
    const targetDirectory = meta?.assignedProjectDir
      ? normalizeProjectPath(meta.assignedProjectDir)
      : null;
    if (!meta?.pendingDirectoryChangeNotice || !targetDirectory) return text;

    const session = state.sessions.find((item) => item.id === sessionId);
    const sourceDirectory = normalizeProjectPath(
      meta.assignedProjectSourceDir ?? session?._projectDir ?? session?.directory ?? "",
    );
    const notice = [
      "<SYSTEM-APPEND>",
      `OpenGUI has reassigned this conversation from project \`${sourceDirectory || "unknown"}\` to project \`${targetDirectory}\`.`,
      "Important: the native backend session may still have its original working directory.",
      `From now on, treat \`${targetDirectory}\` as the intended project root.`,
      `When using tools, file paths, search commands, shell commands, or edits, explicitly target \`${targetDirectory}\` unless the user asks otherwise.`,
      "Do not assume relative paths resolve against the intended project root; use absolute paths when needed.",
      "Do not mention this implementation detail to the user unless it becomes relevant to explain tool behavior.",
      "</SYSTEM-APPEND>",
    ].join("\n");

    dispatch({
      type: "SET_SESSION_META",
      payload: {
        sessionId,
        meta: applySessionMetaPatch(meta, {
          pendingDirectoryChangeNotice: false,
          hideSystemAppendBlocks: true,
        }),
      },
    });

    return `${notice}\n\n${text}`;
  };

  const resolveSessionEntry = async (): Promise<string | null> => {
    const state = getState();
    const decision = decideSessionEntry({
      activeSessionId: state.activeSessionId,
      draftDirectory: state.draftSessionDirectory,
      canStartSession: false,
    });

    switch (decision.type) {
      case "use-active-session":
        return decision.sessionId;
      case "create-session-from-draft": {
        if (draftCreatingRef.current) return null;
        draftCreatingRef.current = true;
        try {
          const newSession = await createSession(undefined, decision.directory);
          if (!newSession) return null;
          dispatch({ type: "CLEAR_DRAFT_SESSION" });
          return newSession.id;
        } finally {
          draftCreatingRef.current = false;
        }
      }
      case "missing-session":
        dispatch({
          type: "SET_ERROR",
          payload: "Select or create a session first.",
        });
        return null;
      case "start-draft-session":
        return null;
    }
  };

  const ensureSessionFromDraft = async (): Promise<string | null> => {
    return await resolveSessionEntry();
  };

  const startDraftSessionSend = async ({
    text,
    images,
    model,
    agent,
    variant,
    nameSourceText,
    errorMessage,
    trackTurnRun = false,
  }: {
    text: string;
    images?: string[];
    model?: SelectedModel;
    agent?: string;
    variant?: string;
    nameSourceText: string;
    errorMessage: string;
    trackTurnRun?: boolean;
  }): Promise<string | null> => {
    const creationRuntime = getCreationRuntime();
    const creationBackendId = getCreationBackendId();
    const draftDirectory = getState().draftSessionDirectory;
    if (!creationRuntime?.startSession || !draftDirectory) return null;
    if (draftCreatingRef.current) return null;

    draftCreatingRef.current = true;
    try {
      await ensureDirectoryConnection(draftDirectory, {
        backendIds: [creationBackendId],
      });
      const pendingTitle = "Untitled";
      dispatch({ type: "SET_BUSY", payload: true });
      const startedAt = Date.now();
      const currentState = getState();
      const session = await startDraftSessionAgentSend({
        runtime: creationRuntime,
        backendId: creationBackendId,
        workspaceId: currentState.activeWorkspaceId,
        baseUrl: currentState.workspaces.find(
          (workspace) => workspace.id === currentState.activeWorkspaceId,
        )?.serverUrl,
        directory: draftDirectory,
        text,
        images,
        selection: { model, agent, variant },
        title: pendingTitle,
      });
      const draftSendState = createDraftSessionSendState({
        session,
        selection: { model, agent, variant },
        title: pendingTitle,
        trackTurnRun,
        isChatDirectory: isChatDirectory(draftDirectory),
        startedAt,
      });
      dispatch({ type: "SESSION_CREATED", payload: draftSendState.titledSession });
      if (draftSendState.turnRun) {
        dispatch({
          type: "TURN_RUN_STARTED",
          payload: draftSendState.turnRun,
        });
      }
      requestSessionAutoName({
        sessionId: session.id,
        sourceText: nameSourceText,
        session: draftSendState.titledSession,
        force: true,
      });
      if (draftSendState.sessionMeta) {
        dispatch({
          type: "SET_SESSION_META",
          payload: {
            sessionId: session.id,
            meta: draftSendState.sessionMeta,
          },
        });
      }
      dispatch({ type: "CLEAR_DRAFT_SESSION" });
      await selectSession(session.id, { session: draftSendState.titledSession });
      scheduleSessionMessageReconcile(session.id, {
        directory: session.directory,
        workspaceId: getState().activeWorkspaceId,
      });
      return session.id;
    } catch (error) {
      dispatch({ type: "SET_ERROR", payload: getErrorMessage(error) || errorMessage });
      dispatch({ type: "SET_BUSY", payload: false });
      return null;
    } finally {
      draftCreatingRef.current = false;
    }
  };

  const dispatchPromptDirect = async (
    sessionId: string,
    text: string,
    images?: string[],
    overrideModel?: SelectedModel,
    overrideAgent?: string,
    overrideVariant?: string,
  ) => {
    const state = getState();
    dispatch({ type: "SET_BUSY", payload: true });

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
    const promptSendState = createPromptSendState({
      sessionId,
      text,
      selection,
    });
    dispatch({
      type: "TURN_RUN_STARTED",
      payload: promptSendState.turnRun,
    });
    dispatch({
      type: "PROMPT_SUBMITTED",
      payload: promptSendState.promptSubmitted,
    });

    try {
      const currentState = getState();
      const currentSession = currentState.sessions.find((session) => session.id === sessionId);
      const { projectTarget } = await sendPromptToAgent({
        sessions: sessionsClient,
        session: currentSession,
        sessionId,
        text,
        images,
        selection,
        activeWorkspaceId: currentState.activeWorkspaceId,
        getWorkspaceBaseUrl,
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
    dispatchingSessionIds,
  });

  const dispatchNextQueued = sessionQueue.dispatchNext;

  const getSelectionSnapshot = () => {
    const state = getState();
    return {
      selectedModel: state.selectedModel,
      selectedAgent: state.selectedAgent,
      variantSelections: state.variantSelections,
      agents: state.agents,
    };
  };

  const resolveCurrentSelection = () => resolveAgentSendSelection(getSelectionSnapshot());

  const shouldStartDraftIntent = () => {
    const state = getState();
    return (
      decideSessionEntry({
        activeSessionId: state.activeSessionId,
        draftDirectory: state.draftSessionDirectory,
        canStartSession: typeof getCreationRuntime()?.startSession === "function",
      }).type === "start-draft-session"
    );
  };

  const startDraftIntent = async ({
    text,
    images,
    errorMessage,
    trackTurnRun = false,
  }: {
    text: string;
    images?: string[];
    errorMessage: string;
    trackTurnRun?: boolean;
  }) => {
    const selection = resolveCurrentSelection();
    await startDraftSessionSend({
      text,
      images,
      model: selection.model,
      agent: selection.agent,
      variant: selection.variant,
      nameSourceText: text,
      errorMessage,
      trackTurnRun,
    });
  };

  const resolveNamedSession = async (sourceText: string): Promise<string | null> => {
    const sessionId = await resolveSessionEntry();
    if (!sessionId) return null;

    requestSessionAutoName({
      sessionId,
      sourceText,
      session: getState().sessions.find((session) => session.id === sessionId),
    });
    return sessionId;
  };

  const sendPrompt = async (text: string, images?: string[], mode?: QueueMode) => {
    if (shouldStartDraftIntent()) {
      await startDraftIntent({ text, images, errorMessage: "Prompt failed", trackTurnRun: true });
      return;
    }

    const sessionId = await resolveNamedSession(text);
    if (!sessionId) return;

    const current = getState();
    const promptDecision = decidePromptDispatch({
      isBusy: current.busySessionIds.has(sessionId),
      text,
      images,
      mode: mode ?? "queue",
      ...getSelectionSnapshot(),
    });

    if (promptDecision.type === "queue") {
      await sessionQueue.enqueuePrompt({
        sessionId,
        text: promptDecision.prompt.text,
        images: promptDecision.prompt.images,
        model: promptDecision.prompt.model,
        agent: promptDecision.prompt.agent,
        variant: promptDecision.prompt.variant,
        mode: promptDecision.prompt.mode,
        insertAt: promptDecision.insertAt,
      });
      if (promptDecision.shouldAbort) {
        await sessionQueue.abort(sessionId);
      } else if (promptDecision.shouldSetAfterPartPending) {
        dispatch({
          type: "SET_AFTER_PART_PENDING",
          payload: { sessionID: sessionId, pending: true },
        });
      }
      return;
    }

    await dispatchPromptDirect(sessionId, prepareDirectoryChangePrompt(sessionId, text), images);
  };

  const sendCommand = async (command: string, args: string) => {
    const commandText = `/${command}${args ? ` ${args}` : ""}`;
    if (shouldStartDraftIntent()) {
      await startDraftIntent({ text: commandText, errorMessage: "Command failed" });
      return;
    }

    const sessionId = await resolveNamedSession(commandText);
    if (!sessionId) return;

    const commandRuntime = getResourceRuntime();
    if (!commandRuntime?.sendCommand) return;

    dispatch({ type: "SET_BUSY", payload: true });
    try {
      const latestSession = getState().sessions.find((session) => session.id === sessionId);
      const current = getState();
      const { projectTarget } = await sendCommandToAgent({
        runtime: commandRuntime,
        session: latestSession,
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
    dispatchNextQueued,
    sendQueuedNow,
    ensureSessionFromDraft,
  };
}
