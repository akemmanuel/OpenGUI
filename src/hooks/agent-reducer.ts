import type {
  Agent,
  Command,
  Message,
  PermissionRequest,
  QuestionRequest,
} from "@/protocol/harness-types";
import type { HarnessId } from "@/agents";
import type { ProjectHydrationState } from "@/hooks/agent-project-hydration";
import type {
  InternalAgentState,
  MessageEntry,
  QueuedPrompt,
  Session,
} from "@/hooks/agent-state-types";

import {
  mergeProjectBackendSessions,
  nextLiveSessionRetainUntil,
  upsertSessionInList,
} from "@/hooks/agent-session-index-merge";
import {
  getSessionHarnessId,
  getSessionSelectedAgent,
  getSessionSelectedModel,
  getSessionSelectedVariant,
  getSessionWorkspaceId,
  parseProjectKey,
} from "@/hooks/agent-session-utils";
import {
  normalizeWorkspace,
  persistProjectMetaMap,
  persistSessionMetaMap,
  persistWorktreeParents,
  type ProjectMeta,
  type SessionMeta,
  type WorktreeParentMap,
} from "@/hooks/agent-state-persistence";
import {
  updateVariantSelections,
  variantKey,
  type VariantSelections,
} from "@/hooks/use-agent-variant-core";
import { prependProjectIfMissing } from "@/lib/sidebar-order";
import { normalizeProjectPath } from "@/lib/utils";
import type { ConnectionStatus, ProvidersData, SelectedModel, Workspace } from "@/types/electron";
import { harnessSessionIdentity, sameHarnessSessionIdentity } from "@/lib/session-identity";
import {
  isAgentAvailable,
  isModelAvailable,
  selectedModelsEqual,
} from "@/hooks/agent-model-selection";
import {
  isQueuePresentationAction,
  mergeQueuePresentationSlice,
  pickQueuePresentationSlice,
  reduceQueuePresentation,
  removeSessionFromQueueSlice,
  renameSessionIdInQueueSlice,
} from "@/hooks/agent-reducer-queue-slice";
import type { SessionListTargetSource } from "@/hooks/agent-project-connection";

const MAX_DELETED_SESSION_IDS = 200;

function getBackendSessionIdentity(session: Session) {
  return harnessSessionIdentity({
    id: session.id,
    _harnessId: getSessionHarnessId(session) ?? undefined,
    _rawId: session._rawId,
  });
}

function sameBackendSession(a: Session, b: Session) {
  return sameHarnessSessionIdentity(
    { id: a.id, _harnessId: getSessionHarnessId(a) ?? undefined, _rawId: a._rawId },
    { id: b.id, _harnessId: getSessionHarnessId(b) ?? undefined, _rawId: b._rawId },
  );
}

function getTurnRunIdForSession(state: InternalAgentState, sessionID: string) {
  const direct = state.activeTurnRunBySession[sessionID];
  if (direct) return direct;

  const matchingSession = state.sessions.find(
    (session) => session.id === sessionID || getBackendSessionIdentity(session) === sessionID,
  );
  const candidates = [
    matchingSession?.id,
    matchingSession ? getBackendSessionIdentity(matchingSession) : undefined,
    state.activeSessionId ?? undefined,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const turnId = state.activeTurnRunBySession[candidate];
    if (turnId) return turnId;
  }
  return undefined;
}

function bindAssistantMessageToActiveTurn(state: InternalAgentState, msg: Message) {
  if (msg.role !== "assistant") return null;
  const activeTurnId = getTurnRunIdForSession(state, msg.sessionID);
  if (!activeTurnId) return null;
  const run = state.turnRuns[activeTurnId];
  if (!run || run.status !== "running") return null;
  const completedAt = typeof msg.time.completed === "number" ? msg.time.completed : undefined;
  const providerID =
    "providerID" in msg && typeof msg.providerID === "string" && msg.providerID.trim()
      ? msg.providerID
      : run.providerID;
  const modelID =
    "modelID" in msg && typeof msg.modelID === "string" && msg.modelID.trim()
      ? msg.modelID
      : run.modelID;
  const nextRun = {
    ...run,
    assistantMessageID: msg.id,
    providerID,
    modelID,
    thinkingLevel: run.thinkingLevel,
    // OpenCode can emit several completed assistant messages for one user turn
    // (assistant text, tool calls, follow-up assistant text, ...).  A
    // message-level completed timestamp is not a turn-level completion
    // signal; SESSION_STATUS idle is the canonical end of the live turn.
    ...(completedAt ? { completedAt } : {}),
  };

  if (
    run.assistantMessageID === nextRun.assistantMessageID &&
    run.providerID === nextRun.providerID &&
    run.modelID === nextRun.modelID &&
    run.completedAt === nextRun.completedAt
  ) {
    return null;
  }

  return {
    turnRuns: {
      ...state.turnRuns,
      [activeTurnId]: nextRun,
    },
  } satisfies Partial<InternalAgentState>;
}

export type Action =
  | { type: "SET_WORKSPACES"; payload: Workspace[] }
  | {
      type: "ADD_WORKSPACE_PROJECT";
      payload: {
        workspaceId: string;
        directory: string;
        serverUrl: string;
        username?: string;
        password?: string;
      };
    }
  | { type: "SET_ACTIVE_WORKSPACE"; payload: string }
  | {
      type: "REORDER_WORKSPACES";
      payload: { fromIndex: number; toIndex: number };
    }
  | {
      type: "REORDER_VISIBLE_WORKSPACE_PROJECTS";
      payload: { workspaceId: string; orderedDirectories: string[] };
    }
  | {
      type: "ASSIGN_PROJECT_WORKSPACE";
      payload: { projectKey: string; workspaceId: string };
    }
  | {
      type: "SET_PROJECT_CONNECTION";
      payload: { projectKey: string; status: ConnectionStatus };
    }
  | {
      type: "SET_PROJECT_HYDRATION";
      payload: { projectKey: string; hydration: ProjectHydrationState };
    }
  | { type: "RESET_PROJECT_HYDRATION" }
  | {
      type: "REMOVE_PROJECT";
      payload: { projectKey: string; directory: string };
    }
  | {
      type: "MERGE_PROJECT_SESSIONS";
      payload: {
        projectKey: string;
        directory: string;
        sessions: Session[];
        harnessIds?: HarnessId[];
        source?: SessionListTargetSource;
      };
    }
  | { type: "SET_ACTIVE_SESSION"; payload: string | null }
  | { type: "SET_SESSION_DRAFT"; payload: { key: string; text: string } }
  | { type: "CLEAR_SESSION_DRAFT"; payload: string }
  | { type: "SET_BUSY"; payload: boolean }
  | {
      type: "TURN_RUN_STARTED";
      payload: {
        id: string;
        sessionID: string;
        startedAt: number;
        providerID?: string;
        modelID?: string;
        thinkingLevel?: string;
      };
    }
  | { type: "SET_ERROR"; payload: string | null }
  | { type: "SESSION_ERROR"; payload: { sessionID?: string; error: string } }
  | {
      type: "SET_BOOT_STATE";
      payload: {
        state: InternalAgentState["bootState"];
        error?: string | null;
        logs?: string | null;
      };
    }
  | {
      type: "SET_PERMISSION";
      payload: PermissionRequest | { sessionID: string; clear: true };
    }
  | {
      type: "SET_QUESTION";
      payload: QuestionRequest | { sessionID: string; clear: true };
    }
  | {
      type: "SET_WORKSPACE_RESOURCES";
      payload: {
        workspaceId: string;
        harnessId: HarnessId;
        projectKey: string | null;
        providersData: ProvidersData;
        agentsData: Agent[];
        commandsData: Command[];
        variantSelections: VariantSelections;
      };
    }
  | { type: "ACTIVATE_WORKSPACE_RESOURCES"; payload: { workspaceId: string } }
  | { type: "EVICT_WORKSPACE_RESOURCES"; payload: { workspaceId: string } }
  | { type: "SET_PROVIDERS"; payload: ProvidersData }
  | { type: "SET_SELECTED_MODEL"; payload: SelectedModel | null }
  | {
      type: "SET_PROMPT_BOX_SELECTION";
      payload: { harnessId: HarnessId; model: SelectedModel };
    }
  | { type: "SET_AGENTS"; payload: Agent[] }
  | { type: "SET_COMMANDS"; payload: Command[] }
  | { type: "SET_SELECTED_AGENT"; payload: string | null }
  | { type: "SET_VARIANT_SELECTIONS"; payload: VariantSelections }
  | { type: "SESSION_CREATED"; payload: Session }
  | { type: "SESSION_UPDATED"; payload: Session }
  | { type: "SESSION_DELETED"; payload: string }
  | { type: "BIND_ASSISTANT_TURN_FROM_TRANSCRIPT"; payload: { entry: MessageEntry } }
  | {
      type: "SESSION_STATUS";
      payload: { sessionID: string; status: { type: string } };
    }
  | {
      type: "INIT_BUSY_SESSIONS";
      payload: Record<string, { type: string }>;
    }
  | { type: "SET_SESSION_QUEUE"; payload: { sessionID: string; prompts: QueuedPrompt[] } }
  | { type: "QUEUE_ADD"; payload: { sessionID: string; prompt: QueuedPrompt } }
  | { type: "QUEUE_SHIFT"; payload: { sessionID: string } }
  | { type: "QUEUE_REMOVE"; payload: { sessionID: string; promptID: string } }
  | {
      type: "QUEUE_REORDER";
      payload: { sessionID: string; fromIndex: number; toIndex: number };
    }
  | {
      type: "QUEUE_UPDATE";
      payload: { sessionID: string; promptID: string; text: string };
    }
  | { type: "QUEUE_CLEAR"; payload: { sessionID: string } }
  | { type: "SET_DEFAULT_CHAT_DIRECTORY"; payload: string | null }
  | {
      type: "SET_ACTIVE_TARGET";
      payload: {
        directory: string;
        harnessId: HarnessId | null;
        resetSelection?: boolean;
        selectedModel?: SelectedModel | null;
        selectedAgent?: string | null;
      };
    }
  | { type: "CLEAR_ACTIVE_TARGET" }
  | { type: "SET_SESSION_NAMING"; payload: { sessionId: string; naming: boolean } }
  | {
      type: "SET_SESSION_META";
      payload: { sessionId: string; meta: SessionMeta };
    }
  | {
      type: "SET_PROJECT_META";
      payload: { projectKey: string; meta: ProjectMeta };
    }
  | {
      type: "REGISTER_WORKTREE";
      payload: { worktreeDir: string; parentDir: string; branch: string };
    }
  | { type: "UNREGISTER_WORKTREE"; payload: string }
  | {
      type: "SET_PENDING_WORKTREE_CLEANUP";
      payload: { worktreeDir: string; parentDir: string } | null;
    }
  | {
      type: "SET_AFTER_PART_PENDING";
      payload: { sessionID: string; pending: boolean };
    }
  | {
      type: "CLEAR_AFTER_PART_TRIGGERED";
      payload: { sessionID: string };
    }
  | {
      type: "SESSION_REPLACED";
      payload: { oldId: string; newId: string; session: Session };
    };

export { mergeProjectBackendSessions } from "@/hooks/agent-session-index-merge";

function touchLiveSessionRetain(
  liveSessionRetainUntil: InternalAgentState["liveSessionRetainUntil"],
  sessionId: string,
): InternalAgentState["liveSessionRetainUntil"] {
  return { ...liveSessionRetainUntil, [sessionId]: nextLiveSessionRetainUntil() };
}

function preserveChatSessionDirectory(state: InternalAgentState, incoming: Session): Session {
  const meta = state.sessionMeta[incoming.id];
  if (meta?.originMode !== "chat") return incoming;
  if (normalizeProjectPath(meta.assignedProjectDir ?? "")) return incoming;

  const existing = state.sessions.find((session) => sameBackendSession(session, incoming));
  const directory = normalizeProjectPath(
    (meta.nativeProjectDir ??
      existing?._projectDir ??
      existing?.directory ??
      state.defaultChatDirectory ??
      "") ||
      "",
  );
  if (!directory) return incoming;

  return {
    ...incoming,
    directory,
    _projectDir: directory,
  };
}

function hasExplicitPlacementMeta(meta: SessionMeta | undefined): boolean {
  if (!meta) return false;
  return (
    Object.hasOwn(meta, "originMode") ||
    Object.hasOwn(meta, "nativeProjectDir") ||
    Object.hasOwn(meta, "assignedProjectDir") ||
    Object.hasOwn(meta, "detachedFromProject")
  );
}

function markDefaultChatListedSessions({
  current,
  directory,
  sessions,
}: {
  current: InternalAgentState["sessionMeta"];
  directory: string;
  sessions: Session[];
}) {
  const nativeProjectDir = normalizeProjectPath(directory);
  if (!nativeProjectDir) return current;

  let changed = false;
  const next = { ...current };
  for (const session of sessions) {
    if (!session?.id) continue;
    const existing = next[session.id];
    if (hasExplicitPlacementMeta(existing)) continue;
    next[session.id] = {
      ...existing,
      originMode: "chat",
      nativeProjectDir,
      assignedProjectDir: null,
    };
    changed = true;
  }
  return changed ? next : current;
}

export function reducer(state: InternalAgentState, action: Action): InternalAgentState {
  if (isQueuePresentationAction(action)) {
    return mergeQueuePresentationSlice(
      state,
      reduceQueuePresentation(pickQueuePresentationSlice(state), action),
    );
  }

  switch (action.type) {
    case "SET_WORKSPACES":
      return {
        ...state,
        workspaces: action.payload.map((workspace) => normalizeWorkspace(workspace)),
      };

    case "ADD_WORKSPACE_PROJECT": {
      const {
        workspaceId,
        directory: rawDirectory,
        serverUrl,
        username,
        password,
      } = action.payload;
      const directory = normalizeProjectPath(rawDirectory);
      let changed = false;
      const nextWorkspaces = state.workspaces.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;
        changed = true;
        const projects = workspace.projects ?? [];
        return normalizeWorkspace({
          ...workspace,
          serverUrl,
          username: username ?? workspace.username,
          password: password ?? workspace.password,
          projects: prependProjectIfMissing(projects, directory),
        });
      });
      return changed ? { ...state, workspaces: nextWorkspaces } : state;
    }

    case "SET_ACTIVE_WORKSPACE": {
      const resources = state.workspaceResources[action.payload];
      return {
        ...state,
        activeWorkspaceId: action.payload,
        providers: resources?.providers ?? [],
        providerDefaults: resources?.providerDefaults ?? {},
        agents: resources?.agents ?? [],
        commands: resources?.commands ?? [],
        variantSelections: resources?.variantSelections ?? {},
      };
    }

    case "REORDER_WORKSPACES": {
      const { fromIndex, toIndex } = action.payload;
      if (state.workspaces.length <= 1) return state;
      if (fromIndex < 0 || fromIndex >= state.workspaces.length) return state;
      const clampedTo = Math.max(0, Math.min(toIndex, state.workspaces.length - 1));
      if (clampedTo === fromIndex) return state;
      const nextWorkspaces = [...state.workspaces];
      const [moved] = nextWorkspaces.splice(fromIndex, 1);
      if (!moved) return state;
      nextWorkspaces.splice(clampedTo, 0, moved);
      return { ...state, workspaces: nextWorkspaces };
    }

    case "REORDER_VISIBLE_WORKSPACE_PROJECTS": {
      const { workspaceId, orderedDirectories } = action.payload;
      const orderedSet = new Set(orderedDirectories);
      if (orderedSet.size <= 1) return state;
      let changed = false;
      const nextWorkspaces = state.workspaces.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;
        const projects = workspace.projects ?? [];
        const projectSet = new Set(projects);
        const nextVisibleOrder = orderedDirectories.filter((directory) =>
          projectSet.has(directory),
        );
        const visibleProjectsInWorkspace = projects.filter((project) => orderedSet.has(project));
        if (visibleProjectsInWorkspace.length <= 1) return workspace;
        if (
          visibleProjectsInWorkspace.every((project, index) => project === nextVisibleOrder[index])
        ) {
          return workspace;
        }
        const nextOrderedProjects = [...nextVisibleOrder];
        const nextProjects = projects.map((project) =>
          orderedSet.has(project) ? (nextOrderedProjects.shift() ?? project) : project,
        );
        changed = true;
        return {
          ...workspace,
          projects: nextProjects,
        };
      });
      return changed ? { ...state, workspaces: nextWorkspaces } : state;
    }

    case "ASSIGN_PROJECT_WORKSPACE": {
      const { projectKey, workspaceId } = action.payload;
      const existing = state.projectWorkspaceMap[projectKey] ?? new Set();
      const updated = new Set(existing).add(workspaceId);
      return {
        ...state,
        projectWorkspaceMap: {
          ...state.projectWorkspaceMap,
          [projectKey]: updated,
        },
      };
    }

    case "SET_PROJECT_CONNECTION": {
      const { projectKey, status } = action.payload;
      const existing = state.connections[projectKey];
      return {
        ...state,
        connections: {
          ...state.connections,
          [projectKey]: {
            ...status,
            kind: status.kind ?? existing?.kind ?? "project",
          },
        },
      };
    }

    case "SET_PROJECT_HYDRATION": {
      const { projectKey, hydration } = action.payload;
      return {
        ...state,
        projectHydration: {
          ...state.projectHydration,
          [projectKey]: hydration,
        },
      };
    }

    case "RESET_PROJECT_HYDRATION": {
      return { ...state, projectHydration: {} };
    }

    case "REMOVE_PROJECT": {
      const { projectKey, directory } = action.payload;
      const { workspaceId } = parseProjectKey(projectKey);
      const isExplicitWorkspaceProject = state.workspaces.some(
        (workspace) => workspace.id === workspaceId && workspace.projects.includes(directory),
      );
      const removedSessionIds = new Set(
        state.sessions
          .filter((s) => {
            if (!isExplicitWorkspaceProject) return false;
            if (getSessionWorkspaceId(s) !== workspaceId) return false;
            const sessionDir = s._projectDir ?? s.directory;
            if (sessionDir !== directory) return false;
            const meta = state.sessionMeta[s.id];
            if (meta?.assignedProjectDir && meta.assignedProjectDir !== directory) return false;
            return true;
          })
          .map((s) => s.id),
      );
      const nextWorkspaces = state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              projects: workspace.projects.filter((project) => project !== directory),
            }
          : workspace,
      );
      const { [projectKey]: _, ...rest } = state.connections;
      const { [projectKey]: _removedHydration, ...restProjectHydration } = state.projectHydration;
      const { [projectKey]: _removedWorkspace, ...restProjectWorkspaceMap } =
        state.projectWorkspaceMap;
      const nextBusy = new Set(
        [...state.busySessionIds].filter((id) => !removedSessionIds.has(id)),
      );
      const nextPermissions: Record<string, PermissionRequest> = {};
      for (const [sid, value] of Object.entries(state.pendingPermissions)) {
        if (!removedSessionIds.has(sid)) nextPermissions[sid] = value;
      }
      const nextQuestions: Record<string, QuestionRequest> = {};
      for (const [sid, value] of Object.entries(state.pendingQuestions)) {
        if (!removedSessionIds.has(sid)) nextQuestions[sid] = value;
      }
      const nextQueues: Record<string, QueuedPrompt[]> = {};
      for (const [sid, value] of Object.entries(state.queuedPrompts)) {
        if (!removedSessionIds.has(sid)) nextQueues[sid] = value;
      }
      const nextUnread = new Set(
        [...state.unreadSessionIds].filter((id) => !removedSessionIds.has(id)),
      );

      const nextProjectMeta = { ...state.projectMeta };
      if (projectKey in nextProjectMeta) {
        delete nextProjectMeta[projectKey];
        persistProjectMetaMap(nextProjectMeta);
      }

      const nextNaming = new Set(state.namingSessionIds);
      for (const sessionId of removedSessionIds) {
        nextNaming.delete(sessionId);
      }

      return {
        ...state,
        workspaces: nextWorkspaces,
        projectMeta: nextProjectMeta,
        connections: rest,
        projectHydration: restProjectHydration,
        projectWorkspaceMap: restProjectWorkspaceMap,
        sessions: state.sessions.filter((s) => {
          if (!isExplicitWorkspaceProject) return true;
          if (getSessionWorkspaceId(s) !== workspaceId) return true;
          const sessionDir = s._projectDir ?? s.directory;
          if (sessionDir !== directory) return true;
          const meta = state.sessionMeta[s.id];
          if (meta?.assignedProjectDir && meta.assignedProjectDir !== directory) return true;
          return false;
        }),
        busySessionIds: nextBusy,
        namingSessionIds: nextNaming,
        unreadSessionIds: nextUnread,
        pendingPermissions: nextPermissions,
        pendingQuestions: nextQuestions,
        queuedPrompts: nextQueues,
        ...(state.activeSessionId && removedSessionIds.has(state.activeSessionId)
          ? {
              activeSessionId: null,
              isBusy: false,
            }
          : {}),
        activeTargetDirectory:
          state.activeTargetDirectory === directory ? null : state.activeTargetDirectory,
        activeTargetHarnessId:
          state.activeTargetDirectory === directory ? null : state.activeTargetHarnessId,
      };
    }

    case "SET_BOOT_STATE": {
      return {
        ...state,
        bootState: action.payload.state,
        bootError: action.payload.error ?? null,
        bootLogs: action.payload.logs ?? null,
      };
    }

    case "MERGE_PROJECT_SESSIONS": {
      const { projectKey, directory, sessions, harnessIds, source } = action.payload;
      const { workspaceId } = parseProjectKey(projectKey);
      const nextSessionMeta =
        source === "default-chat"
          ? markDefaultChatListedSessions({
              current: state.sessionMeta,
              directory,
              sessions,
            })
          : state.sessionMeta;
      if (nextSessionMeta !== state.sessionMeta) persistSessionMetaMap(nextSessionMeta);
      return {
        ...state,
        sessionMeta: nextSessionMeta,
        sessions: mergeProjectBackendSessions({
          current: state.sessions,
          workspaceId,
          directory,
          incoming: sessions,
          harnessIds,
          retain: {
            busySessionIds: state.busySessionIds,
            activeTurnRunBySession: state.activeTurnRunBySession,
            liveSessionRetainUntil: state.liveSessionRetainUntil,
          },
        }),
      };
    }

    case "SET_ACTIVE_SESSION": {
      const sid = action.payload;
      const selectedSession = sid ? state.sessions.find((session) => session.id === sid) : null;
      const sessionModel = getSessionSelectedModel(selectedSession);
      const sessionVariant = getSessionSelectedVariant(selectedSession);
      const sessionAgent = getSessionSelectedAgent(selectedSession);
      const meta = sid ? state.sessionMeta[sid] : undefined;
      const nextSelectedModel =
        sessionModel ??
        (meta && Object.hasOwn(meta, "selectedModel")
          ? isModelAvailable(state.providers, meta.selectedModel ?? null)
            ? (meta.selectedModel ?? null)
            : state.selectedModel
          : state.selectedModel);
      const nextSelectedAgent =
        sessionAgent ??
        (meta && Object.hasOwn(meta, "selectedAgent")
          ? isAgentAvailable(state.agents, meta.selectedAgent)
            ? (meta.selectedAgent ?? null)
            : state.selectedAgent
          : state.selectedAgent);
      const variantSourceModel = sessionModel ?? meta?.selectedModel ?? null;
      const hasVariantSource =
        Boolean(sessionModel) || Boolean(meta && Object.hasOwn(meta, "selectedVariant"));
      const desiredVariant = sessionModel
        ? (sessionVariant ??
          (selectedModelsEqual(sessionModel, meta?.selectedModel)
            ? (meta?.selectedVariant ?? undefined)
            : undefined))
        : (meta?.selectedVariant ?? undefined);
      let nextVariantSelections = state.variantSelections;
      if (
        hasVariantSource &&
        selectedModelsEqual(nextSelectedModel, variantSourceModel) &&
        nextSelectedModel
      ) {
        const key = variantKey(nextSelectedModel.providerID, nextSelectedModel.modelID);
        if (nextVariantSelections[key] !== desiredVariant) {
          nextVariantSelections = updateVariantSelections(
            state.variantSelections,
            key,
            desiredVariant,
          );
        }
      }

      // Clear unread flag for the session being viewed
      let nextUnread = state.unreadSessionIds;
      if (sid && state.unreadSessionIds.has(sid)) {
        nextUnread = new Set(state.unreadSessionIds);
        nextUnread.delete(sid);
      }
      const nextWorkspaces = state.workspaces.map((workspace) =>
        workspace.id === state.activeWorkspaceId
          ? {
              ...workspace,
              lastActiveSessionId: sid,
            }
          : workspace,
      );
      const activeTurnId = sid ? state.activeTurnRunBySession[sid] : undefined;
      const hasRunningTurn = Boolean(
        activeTurnId && state.turnRuns[activeTurnId]?.status === "running",
      );
      return {
        ...state,
        workspaces: nextWorkspaces,
        activeSessionId: sid,
        selectedModel: nextSelectedModel,
        selectedAgent: nextSelectedAgent,
        variantSelections: nextVariantSelections,
        isBusy: sid ? state.busySessionIds.has(sid) || hasRunningTurn : false,
        unreadSessionIds: nextUnread,
        activeTargetDirectory: sid ? null : state.activeTargetDirectory,
        activeTargetHarnessId: sid ? null : state.activeTargetHarnessId,
      };
    }

    case "SET_SESSION_DRAFT": {
      const { key, text } = action.payload;
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        if (!(key in state.sessionDrafts)) return state;
        const { [key]: _removed, ...rest } = state.sessionDrafts;
        return { ...state, sessionDrafts: rest };
      }
      if (state.sessionDrafts[key] === text) return state;
      return {
        ...state,
        sessionDrafts: { ...state.sessionDrafts, [key]: text },
      };
    }

    case "CLEAR_SESSION_DRAFT": {
      if (!(action.payload in state.sessionDrafts)) return state;
      const { [action.payload]: _removed, ...rest } = state.sessionDrafts;
      return { ...state, sessionDrafts: rest };
    }

    case "SET_BUSY":
      return { ...state, isBusy: action.payload };

    case "TURN_RUN_STARTED": {
      const run = action.payload;
      const busySessionIds = new Set(state.busySessionIds);
      busySessionIds.add(run.sessionID);
      const { [run.sessionID]: _clearedSessionError, ...sessionErrors } = state.sessionErrors;
      return {
        ...state,
        sessionErrors,
        busySessionIds,
        ...(run.sessionID === state.activeSessionId ? { isBusy: true } : {}),
        turnRuns: {
          ...state.turnRuns,
          [run.id]: { ...run, status: "running" },
        },
        activeTurnRunBySession: {
          ...state.activeTurnRunBySession,
          [run.sessionID]: run.id,
        },
      };
    }

    case "SET_ERROR":
      return {
        ...state,
        lastError: action.payload,
        ...(action.payload === null ? { sessionErrors: {} } : {}),
      };

    case "SESSION_ERROR": {
      const { sessionID, error } = action.payload;
      if (!sessionID) return { ...state, lastError: error };

      const newBusy = new Set(state.busySessionIds);
      newBusy.delete(sessionID);
      const activeTurnId = getTurnRunIdForSession(state, sessionID);
      const activeTurn = activeTurnId ? state.turnRuns[activeTurnId] : undefined;
      const nextTurnRuns =
        activeTurn?.status === "running"
          ? {
              ...state.turnRuns,
              [activeTurn.id]: {
                ...activeTurn,
                completedAt: Date.now(),
                status: "error" as const,
              },
            }
          : state.turnRuns;
      const nextActiveTurnRunBySession = Object.fromEntries(
        Object.entries(state.activeTurnRunBySession).filter(([sid, turnId]) => {
          if (sid === sessionID) return false;
          return turnId !== activeTurnId;
        }),
      );

      return {
        ...state,
        lastError: error,
        sessionErrors: { ...state.sessionErrors, [sessionID]: error },
        busySessionIds: newBusy,
        turnRuns: nextTurnRuns,
        activeTurnRunBySession: nextActiveTurnRunBySession,
        ...(sessionID === state.activeSessionId ? { isBusy: false } : {}),
      };
    }

    case "SET_PERMISSION": {
      const p = action.payload;
      if ("clear" in p) {
        const { [p.sessionID]: _, ...rest } = state.pendingPermissions;
        return { ...state, pendingPermissions: rest };
      }
      return {
        ...state,
        pendingPermissions: { ...state.pendingPermissions, [p.sessionID]: p },
      };
    }

    case "SET_QUESTION": {
      const q = action.payload;
      if ("clear" in q) {
        const { [q.sessionID]: _, ...rest } = state.pendingQuestions;
        return { ...state, pendingQuestions: rest };
      }
      return {
        ...state,
        pendingQuestions: { ...state.pendingQuestions, [q.sessionID]: q },
      };
    }

    case "SET_WORKSPACE_RESOURCES": {
      const { workspaceId, harnessId, projectKey, providersData, agentsData, commandsData } =
        action.payload;
      const resourceState = {
        providers: providersData.providers,
        providerDefaults: providersData.default,
        agents: agentsData,
        commands: commandsData,
        variantSelections: action.payload.variantSelections,
        loadedHarnessId: harnessId,
        loadedProjectKey: projectKey,
      };
      const isActive = workspaceId === state.activeWorkspaceId;
      return {
        ...state,
        workspaceResources: {
          ...state.workspaceResources,
          [workspaceId]: resourceState,
        },
        ...(isActive
          ? {
              providers: resourceState.providers,
              providerDefaults: resourceState.providerDefaults,
              agents: resourceState.agents,
              commands: resourceState.commands,
              variantSelections: resourceState.variantSelections,
            }
          : null),
      };
    }

    case "ACTIVATE_WORKSPACE_RESOURCES": {
      const resources = state.workspaceResources[action.payload.workspaceId];
      return {
        ...state,
        providers: resources?.providers ?? [],
        providerDefaults: resources?.providerDefaults ?? {},
        agents: resources?.agents ?? [],
        commands: resources?.commands ?? [],
        variantSelections: resources?.variantSelections ?? {},
      };
    }

    case "EVICT_WORKSPACE_RESOURCES": {
      const { [action.payload.workspaceId]: _removed, ...workspaceResources } =
        state.workspaceResources;
      const isActive = action.payload.workspaceId === state.activeWorkspaceId;
      return {
        ...state,
        workspaceResources,
        ...(isActive
          ? {
              providers: [],
              providerDefaults: {},
              agents: [],
              commands: [],
              variantSelections: {},
            }
          : null),
      };
    }

    case "SET_PROVIDERS":
      return {
        ...state,
        providers: action.payload.providers,
        providerDefaults: action.payload.default,
      };

    case "SET_SELECTED_MODEL":
      return { ...state, selectedModel: action.payload };

    case "SET_PROMPT_BOX_SELECTION":
      return {
        ...state,
        selectedModel: action.payload.model,
        ...(state.activeTargetDirectory && !state.activeSessionId
          ? { activeTargetHarnessId: action.payload.harnessId }
          : null),
      };

    case "SET_AGENTS":
      return { ...state, agents: action.payload };

    case "SET_COMMANDS":
      return { ...state, commands: action.payload };

    case "SET_SELECTED_AGENT":
      return { ...state, selectedAgent: action.payload };

    case "SET_VARIANT_SELECTIONS": {
      const activeWorkspaceId = state.activeWorkspaceId;
      const existing = state.workspaceResources[activeWorkspaceId];
      return {
        ...state,
        variantSelections: action.payload,
        workspaceResources: existing
          ? {
              ...state.workspaceResources,
              [activeWorkspaceId]: {
                ...existing,
                variantSelections: action.payload,
              },
            }
          : state.workspaceResources,
      };
    }

    case "SESSION_CREATED": {
      const created = preserveChatSessionDirectory(state, action.payload);
      // Ignore subagent / child sessions - only root sessions appear in the sidebar.
      if (created.parentID) return state;
      // Ignore backend echoes for sessions that were optimistically deleted.
      if (state._deletedSessionIds.has(created.id)) return state;
      const previousActiveSession = state.activeSessionId
        ? state.sessions.find((session) => session.id === state.activeSessionId)
        : null;
      const shouldCanonicalizeActive = previousActiveSession
        ? sameBackendSession(previousActiveSession, created)
        : false;
      return {
        ...state,
        activeSessionId: shouldCanonicalizeActive ? created.id : state.activeSessionId,
        liveSessionRetainUntil: touchLiveSessionRetain(state.liveSessionRetainUntil, created.id),
        sessions: upsertSessionInList(state.sessions, created),
      };
    }

    case "SESSION_UPDATED": {
      const updated = preserveChatSessionDirectory(state, action.payload);
      // Ignore subagent / child sessions - only root sessions appear in the sidebar.
      if (updated.parentID) return state;
      // Ignore backend echoes for sessions that were optimistically deleted.
      // Without this guard the session flickers back into the sidebar
      // between the optimistic removal and the server's session.deleted event.
      if (state._deletedSessionIds.has(updated.id)) return state;
      const exists = state.sessions.some((s) => sameBackendSession(s, updated));
      const previousActiveSession = state.activeSessionId
        ? state.sessions.find((session) => session.id === state.activeSessionId)
        : null;
      const shouldCanonicalizeActive = previousActiveSession
        ? sameBackendSession(previousActiveSession, updated)
        : false;
      // Update in-place without re-sorting to prevent the sidebar from
      // jumping around while sessions receive streaming updates.
      return {
        ...state,
        activeSessionId: shouldCanonicalizeActive ? updated.id : state.activeSessionId,
        liveSessionRetainUntil: touchLiveSessionRetain(state.liveSessionRetainUntil, updated.id),
        sessions: exists
          ? state.sessions.map((s) => (sameBackendSession(s, updated) ? updated : s))
          : [updated, ...state.sessions],
      };
    }

    case "SET_SESSION_NAMING": {
      const nextNaming = new Set(state.namingSessionIds);
      if (action.payload.naming) {
        nextNaming.add(action.payload.sessionId);
      } else {
        nextNaming.delete(action.payload.sessionId);
      }
      return { ...state, namingSessionIds: nextNaming };
    }

    case "SESSION_REPLACED": {
      // A new session was pre-created with a temp UUID; the real session ID
      // has now arrived from the subprocess.  Rename every reference.
      const { oldId, newId, session: realSession } = action.payload;

      const renameSessionId = (id: string) => (id === oldId ? newId : id);
      const nextSessionMeta = { ...state.sessionMeta };
      if (oldId in nextSessionMeta) {
        nextSessionMeta[newId] = nextSessionMeta[oldId]!;
        delete nextSessionMeta[oldId];
        persistSessionMetaMap(nextSessionMeta);
      }

      const nextSessions = state.sessions.map((s) => (s.id === oldId ? realSession : s));

      const nextBusy = new Set([...state.busySessionIds].map(renameSessionId));
      const nextNaming = new Set([...state.namingSessionIds].map(renameSessionId));
      const nextActiveTurnRunBySession = Object.fromEntries(
        Object.entries(state.activeTurnRunBySession).map(([sessionId, turnId]) => [
          renameSessionId(sessionId),
          turnId,
        ]),
      );
      const nextTurnRuns = Object.fromEntries(
        Object.entries(state.turnRuns).map(([turnId, run]) => [
          turnId,
          { ...run, sessionID: renameSessionId(run.sessionID) },
        ]),
      );

      const queuePatch = renameSessionIdInQueueSlice(
        pickQueuePresentationSlice(state),
        oldId,
        newId,
      );

      const nextLiveRetain = { ...state.liveSessionRetainUntil };
      if (oldId in nextLiveRetain) {
        nextLiveRetain[newId] = nextLiveRetain[oldId]!;
        delete nextLiveRetain[oldId];
      }
      nextLiveRetain[newId] = nextLiveSessionRetainUntil();

      return {
        ...state,
        sessions: nextSessions,
        sessionMeta: nextSessionMeta,
        activeSessionId: state.activeSessionId === oldId ? newId : state.activeSessionId,
        busySessionIds: nextBusy,
        activeTurnRunBySession: nextActiveTurnRunBySession,
        turnRuns: nextTurnRuns,
        namingSessionIds: nextNaming,
        liveSessionRetainUntil: nextLiveRetain,
        ...queuePatch,
      };
    }

    case "SESSION_DELETED": {
      const deletedId = action.payload;
      const alreadyGone = !state.sessions.some((s) => s.id === deletedId);

      // Backend echo after optimistic delete - session is already removed.
      // Clean the ID out of _deletedSessionIds (no longer needed) and
      // return the same state reference to avoid a re-render.
      if (alreadyGone) {
        if (state._deletedSessionIds.has(deletedId)) {
          const nextDeleted = new Set(state._deletedSessionIds);
          nextDeleted.delete(deletedId);
          return { ...state, _deletedSessionIds: nextDeleted };
        }
        return state;
      }

      // Track that this session was deleted so that any straggling
      // SESSION_UPDATED / SESSION_CREATED backend events don't re-add it.
      const nextDeleted = new Set(state._deletedSessionIds);
      nextDeleted.add(deletedId);
      // Cap to prevent unbounded growth
      while (nextDeleted.size > MAX_DELETED_SESSION_IDS) {
        const first = nextDeleted.values().next().value;
        if (first !== undefined) {
          nextDeleted.delete(first);
        } else {
          break;
        }
      }

      const queuePatch = removeSessionFromQueueSlice(pickQueuePresentationSlice(state), deletedId);
      const nextUnread = new Set(state.unreadSessionIds);
      nextUnread.delete(deletedId);
      const nextNaming = new Set(state.namingSessionIds);
      nextNaming.delete(deletedId);
      const nextDrafts = { ...state.sessionDrafts };
      delete nextDrafts[`session:${deletedId}`];

      const nextSessionMeta = { ...state.sessionMeta };
      if (deletedId in nextSessionMeta) {
        delete nextSessionMeta[deletedId];
        persistSessionMetaMap(nextSessionMeta);
      }

      return {
        ...state,
        workspaces: state.workspaces.map((workspace) =>
          workspace.lastActiveSessionId === deletedId
            ? { ...workspace, lastActiveSessionId: null }
            : workspace,
        ),
        sessions: state.sessions.filter((s) => s.id !== deletedId),
        ...queuePatch,
        unreadSessionIds: nextUnread,
        namingSessionIds: nextNaming,
        sessionDrafts: nextDrafts,
        sessionMeta: nextSessionMeta,
        _deletedSessionIds: nextDeleted,
        ...(state.activeSessionId === deletedId
          ? {
              activeSessionId: null,
              isBusy: false,
            }
          : {}),
      };
    }

    case "BIND_ASSISTANT_TURN_FROM_TRANSCRIPT": {
      const patch = bindAssistantMessageToActiveTurn(state, action.payload.entry.info);
      return patch ? { ...state, ...patch } : state;
    }

    case "SESSION_STATUS": {
      const { sessionID, status } = action.payload;
      const retryMessage =
        status.type === "retry" &&
        "message" in status &&
        typeof status.message === "string" &&
        status.message.trim()
          ? status.message.trim()
          : null;
      const isBusy = status.type === "busy" || status.type === "retry";
      const newBusy = new Set(state.busySessionIds);
      if (isBusy) {
        newBusy.add(sessionID);
      } else {
        newBusy.delete(sessionID);
      }
      const nextSessionErrors = retryMessage
        ? { ...state.sessionErrors, [sessionID]: retryMessage }
        : status.type === "idle" && state.sessionErrors[sessionID]
          ? Object.fromEntries(
              Object.entries(state.sessionErrors).filter(([id]) => id !== sessionID),
            )
          : state.sessionErrors;
      // Mark session as unread when it finishes generating (busy -> idle)
      // and the user is not currently viewing it
      let nextUnread = state.unreadSessionIds;
      if (!isBusy && state.busySessionIds.has(sessionID) && sessionID !== state.activeSessionId) {
        nextUnread = new Set(state.unreadSessionIds);
        nextUnread.add(sessionID);
      }
      const activeTurnId = getTurnRunIdForSession(state, sessionID);
      const activeTurn = activeTurnId ? state.turnRuns[activeTurnId] : undefined;
      const completedTurnPatch =
        !isBusy && activeTurn?.status === "running"
          ? {
              turnRuns: {
                ...state.turnRuns,
                [activeTurn.id]: {
                  ...activeTurn,
                  completedAt: Date.now(),
                  status: "completed" as const,
                },
              },
              activeTurnRunBySession: Object.fromEntries(
                Object.entries(state.activeTurnRunBySession).filter(([sid]) => sid !== sessionID),
              ),
            }
          : {};
      return {
        ...state,
        ...completedTurnPatch,
        busySessionIds: newBusy,
        sessionErrors: nextSessionErrors,
        ...(retryMessage ? { lastError: retryMessage } : {}),
        unreadSessionIds: nextUnread,
        ...(sessionID === state.activeSessionId ? { isBusy } : {}),
      };
    }

    case "INIT_BUSY_SESSIONS": {
      const statuses = action.payload as Record<string, { type: string }>;
      const newBusy = new Set(state.busySessionIds);
      for (const [sessionID, status] of Object.entries(statuses)) {
        if (status.type === "busy") {
          newBusy.add(sessionID);
        } else {
          newBusy.delete(sessionID);
        }
      }
      return {
        ...state,
        busySessionIds: newBusy,
        ...(state.activeSessionId && statuses[state.activeSessionId]
          ? {
              isBusy: statuses[state.activeSessionId]?.type === "busy",
            }
          : {}),
      };
    }

    case "SET_DEFAULT_CHAT_DIRECTORY":
      return { ...state, defaultChatDirectory: action.payload };

    case "SET_ACTIVE_TARGET":
      return {
        ...state,
        activeTargetDirectory: action.payload.directory,
        activeTargetHarnessId: action.payload.harnessId,
        activeSessionId: null,
        selectedModel: Object.hasOwn(action.payload, "selectedModel")
          ? (action.payload.selectedModel ?? null)
          : action.payload.resetSelection
            ? null
            : state.selectedModel,
        selectedAgent: Object.hasOwn(action.payload, "selectedAgent")
          ? (action.payload.selectedAgent ?? null)
          : action.payload.resetSelection
            ? null
            : state.selectedAgent,
        isBusy: false,
      };

    case "CLEAR_ACTIVE_TARGET":
      return {
        ...state,
        activeTargetDirectory: null,
        activeTargetHarnessId: null,
      };

    case "SET_SESSION_META": {
      const { sessionId, meta } = action.payload;
      const nextMeta = { ...state.sessionMeta };
      const existing = nextMeta[sessionId] ?? {};
      nextMeta[sessionId] = { ...existing, ...meta };
      persistSessionMetaMap(nextMeta);
      const affectsSidebarPlacement =
        Object.hasOwn(meta, "originMode") ||
        Object.hasOwn(meta, "assignedProjectDir") ||
        Object.hasOwn(meta, "detachedFromProject");
      return {
        ...state,
        sessionMeta: nextMeta,
        sessions: affectsSidebarPlacement
          ? state.sessions.map((session) => (session.id === sessionId ? { ...session } : session))
          : state.sessions,
      };
    }

    case "SET_PROJECT_META": {
      const { projectKey, meta } = action.payload;
      const nextMeta = { ...state.projectMeta };
      const existing = nextMeta[projectKey] ?? {};
      nextMeta[projectKey] = { ...existing, ...meta };
      persistProjectMetaMap(nextMeta);
      return { ...state, projectMeta: nextMeta };
    }

    case "REGISTER_WORKTREE": {
      const { worktreeDir, parentDir, branch } = action.payload;
      const now = new Date().toISOString();
      const next: WorktreeParentMap = {
        ...state.worktreeParents,
        [worktreeDir]: {
          parentDir,
          branch,
          createdAt: now,
          lastOpenedAt: now,
        },
      };
      persistWorktreeParents(next);
      return { ...state, worktreeParents: next };
    }

    case "UNREGISTER_WORKTREE": {
      const next = { ...state.worktreeParents };
      delete next[action.payload];
      persistWorktreeParents(next);
      return { ...state, worktreeParents: next };
    }

    case "SET_PENDING_WORKTREE_CLEANUP":
      return { ...state, pendingWorktreeCleanup: action.payload };

    default:
      return state;
  }
}
