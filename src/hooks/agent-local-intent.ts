import type { AgentBackendDescriptor, AgentBackendTarget } from "@/agents/backend";
import type { SessionMeta } from "@/hooks/agent-state-persistence";
import {
  resolveAgentSendSelection,
  sendCommandToAgent,
  sendPromptToAgent,
} from "@/hooks/agent-send";
import { createSessionQueueOrchestrator } from "@/hooks/agent-session-queue";
import { createPromptSendState } from "@/hooks/agent-send-state";
import { decidePromptDispatch } from "@/hooks/agent-prompt-routing";
import { decideSessionEntry } from "@/hooks/agent-session-entry";
import type { InternalAgentState, QueueMode, Session } from "@/hooks/agent-state-types";
import { getSessionDraftKey } from "@/lib/session-drafts";
import { generateSessionTitle } from "@/lib/session-namer";
import { normalizeProjectPath } from "@/lib/utils";
import type { OpenGuiClient } from "@/protocol/client";
import type { SelectedModel } from "@/types/electron";

interface SessionCreationLock {
  current: boolean;
}

interface LocalIntentOptions {
  getState: () => InternalAgentState;
  getResourceRuntime: () => AgentBackendDescriptor["runtime"] | undefined;
  getCurrentVariant: () => string | undefined;
  getWorkspaceBaseUrl?: (workspaceId?: string | null) => string | undefined;
  sessionsClient: OpenGuiClient["sessions"];
  createSession: (title?: string, directory?: string) => Promise<Session | null>;
  scheduleSessionMessageReconcile: (sessionId: string, projectTarget?: AgentBackendTarget) => void;
  requestSessionAutoName: (input: {
    sessionId: string;
    sourceText: string;
    session?: Session | null;
    force?: boolean;
  }) => void;
  dispatch: (action: unknown) => void;
  dispatchingSessionIds: Set<string>;
  sessionCreatingRef: SessionCreationLock;
}

export interface LocalIntentOrchestrator {
  sendPrompt: (text: string, images?: string[], mode?: QueueMode) => Promise<void>;
  sendCommand: (command: string, args: string) => Promise<void>;
  dispatchNextQueued: (sessionId: string) => Promise<void>;
  sendQueuedNow: (sessionId: string, promptId: string) => Promise<void>;
  ensureSession: () => Promise<string | null>;
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
    dispatchingSessionIds,
    sessionCreatingRef,
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

  const sendPrompt = async (text: string, images?: string[], mode?: QueueMode) => {
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
    ensureSession,
  };
}
