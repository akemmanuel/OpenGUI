import type {
  Command,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Agent,
} from "@opencode-ai/sdk/v2/client";
import type { HarnessId } from "@/agents";
import type {
  InternalAgentState,
  MessageEntry,
  QueuedPrompt,
  Session,
} from "@/hooks/agent-state-types";
import {
  applyStreamingDeltaToPart,
  bufferNonActiveEvent,
  createOptimisticUserMessage,
  createPlaceholderMessageEntry,
  createPlaceholderPart,
  finalizeRunningToolPartsForSession,
  getChildSessionId,
  limitMessageWindow,
  MAX_SESSION_BUFFER_CACHE,
  mergeMessageSnapshot,
  mergeSnapshotPartWithExisting,
  normalizeMessageEntries,
  removeMatchingOptimisticUserMessage,
  tagPartWithDeltaPositions,
  updateMessageArray,
} from "@/hooks/agent-message-state";
import {
  getSessionHarnessId,
  getSessionSelectedAgent,
  getSessionSelectedModel,
  getSessionSelectedVariant,
  getSessionWorkspaceId,
  parseProjectKey,
  sortSessionsNewestFirst,
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
import {
  harnessSessionIdentity,
  rawSessionIdForHarness,
  sameHarnessSessionIdentity,
} from "@/lib/session-identity";
import {
  isAgentAvailable,
  isModelAvailable,
  selectedModelsEqual,
} from "@/hooks/agent-model-selection";

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

  return {
    turnRuns: {
      ...state.turnRuns,
      [activeTurnId]: {
        ...run,
        assistantMessageID: msg.id,
        providerID:
          "providerID" in msg && typeof msg.providerID === "string"
            ? msg.providerID
            : run.providerID,
        modelID: "modelID" in msg && typeof msg.modelID === "string" ? msg.modelID : run.modelID,
        thinkingLevel: run.thinkingLevel,
        // OpenCode can emit several completed assistant messages for one user turn
        // (assistant text, tool calls, follow-up assistant text, ...).  A
        // message-level completed timestamp is not a turn-level completion
        // signal; SESSION_STATUS idle is the canonical end of the live turn.
        ...(completedAt ? { completedAt } : {}),
      },
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
      };
    }
  | { type: "SET_ACTIVE_SESSION"; payload: string | null }
  | { type: "SET_SESSION_DRAFT"; payload: { key: string; text: string } }
  | { type: "CLEAR_SESSION_DRAFT"; payload: string }
  | {
      type: "SET_MESSAGES";
      payload: {
        messages: MessageEntry[];
        hasMore: boolean;
        nextCursor?: string | null;
        mode?: "replace" | "prepend" | "append";
      };
    }
  | {
      type: "PROMPT_SUBMITTED";
      payload: { id: string; sessionID: string; text: string; createdAt: number };
    }
  | { type: "SET_LOADING_OLDER_MESSAGES"; payload: boolean }
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
  | { type: "SET_AGENTS"; payload: Agent[] }
  | { type: "SET_COMMANDS"; payload: Command[] }
  | { type: "SET_SELECTED_AGENT"; payload: string | null }
  | { type: "SET_VARIANT_SELECTIONS"; payload: VariantSelections }
  | { type: "SESSION_CREATED"; payload: Session }
  | { type: "SESSION_UPDATED"; payload: Session }
  | { type: "SESSION_DELETED"; payload: string }
  | { type: "MESSAGE_UPDATED"; payload: Message }
  | {
      type: "MESSAGE_REPLACED";
      payload: { sessionID: string; oldId: string; message: Message; parts: Part[] };
    }
  | { type: "PART_UPDATED"; payload: { part: Part } }
  | {
      type: "PART_DELTA";
      payload: {
        sessionID: string;
        messageID: string;
        partID: string;
        field: string;
        delta: string;
      };
    }
  | {
      type: "PART_REMOVED";
      payload: { sessionID: string; messageID: string; partID: string };
    }
  | {
      type: "MESSAGE_REMOVED";
      payload: { sessionID: string; messageID: string };
    }
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
      payload: { directory: string; harnessId: HarnessId | null };
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
      type: "LOAD_CHILD_SESSION";
      payload: {
        childSessionId: string;
        messages: Array<{ info: Message; parts: Part[] }>;
      };
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

export function mergeProjectBackendSessions({
  current,
  workspaceId,
  directory,
  incoming,
  harnessIds,
}: {
  current: Session[];
  workspaceId: string;
  directory: string;
  incoming: Session[];
  harnessIds?: HarnessId[];
}) {
  if (harnessIds && harnessIds.length === 0) return sortSessionsNewestFirst(current);
  const backendScope = harnessIds ? new Set(harnessIds) : null;
  const incomingIds = new Set(incoming.map((session) => session.id));
  const incomingBackendRawKeys = new Set(
    incoming.flatMap((session) => {
      const harnessId = getSessionHarnessId(session);
      const rawId = harnessId
        ? (session._rawId ?? rawSessionIdForHarness(session.id, harnessId))
        : session.id;
      return harnessId ? [`${harnessId}\0${rawId}`] : [];
    }),
  );
  return sortSessionsNewestFirst([
    ...current.filter((session) => {
      if (incomingIds.has(session.id)) return false;
      const sessionBackendId = getSessionHarnessId(session);
      const sessionRawId = sessionBackendId
        ? (session._rawId ?? rawSessionIdForHarness(session.id, sessionBackendId))
        : session.id;
      if (sessionBackendId && incomingBackendRawKeys.has(`${sessionBackendId}\0${sessionRawId}`)) {
        return false;
      }
      if (getSessionWorkspaceId(session) !== workspaceId) return true;
      if ((session._projectDir ?? session.directory) !== directory) return true;
      if (!backendScope) return false;
      const harnessId = getSessionHarnessId(session);
      return !harnessId || !backendScope.has(harnessId);
    }),
    ...incoming,
  ]);
}

function getAssignedProjectDir(sessionMeta: InternalAgentState["sessionMeta"], sessionId: string) {
  const assigned = sessionMeta[sessionId]?.assignedProjectDir;
  return assigned ? normalizeProjectPath(assigned) : null;
}

export function reducer(state: InternalAgentState, action: Action): InternalAgentState {
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
      const nextBuffers: typeof state._sessionBuffers = {};
      for (const [sid, value] of Object.entries(state._sessionBuffers)) {
        if (!removedSessionIds.has(sid)) nextBuffers[sid] = value;
      }
      const nextUnread = new Set(
        [...state.unreadSessionIds].filter((id) => !removedSessionIds.has(id)),
      );

      // Clean up child session data for removed sessions.
      // Find child session IDs referenced by the removed sessions' messages.
      const childIdsToRemove = new Set<string>();
      // If the active session is being removed, scan its messages
      if (state.activeSessionId && removedSessionIds.has(state.activeSessionId)) {
        for (const msg of state.messages) {
          for (const part of msg.parts) {
            const childSid = getChildSessionId(part);
            if (childSid) {
              childIdsToRemove.add(childSid);
            }
          }
        }
      }
      // Also remove any removed session IDs that were tracked as children
      for (const sid of removedSessionIds) {
        childIdsToRemove.add(sid);
      }

      let nextChildSessions = state.childSessions;
      let nextTracked = state.trackedChildSessionIds;
      if (childIdsToRemove.size > 0) {
        nextChildSessions = { ...state.childSessions };
        for (const cid of childIdsToRemove) {
          delete nextChildSessions[cid];
        }
        nextTracked = new Set(state.trackedChildSessionIds);
        for (const cid of childIdsToRemove) {
          nextTracked.delete(cid);
        }
      }

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
        _sessionBuffers: nextBuffers,
        childSessions: nextChildSessions,
        trackedChildSessionIds: nextTracked,
        ...(state.activeSessionId && removedSessionIds.has(state.activeSessionId)
          ? {
              activeSessionId: null,
              messages: [],
              messageHistoryHasMore: false,
              messageHistoryCursor: null,
              isLoadingOlderMessages: false,
              isBusy: false,
            }
          : {}),
        activeTargetDirectory:
          state.activeTargetDirectory === directory ? null : state.activeTargetDirectory,
        activeTargetBackendId:
          state.activeTargetDirectory === directory ? null : state.activeTargetBackendId,
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
      const { projectKey, directory, sessions, harnessIds } = action.payload;
      const { workspaceId } = parseProjectKey(projectKey);
      return {
        ...state,
        sessions: mergeProjectBackendSessions({
          current: state.sessions,
          workspaceId,
          directory,
          incoming: sessions,
          harnessIds,
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
      let startingBuffers = state._sessionBuffers;
      const previousSid = state.activeSessionId;
      // Always cache outgoing session messages (not just busy ones) for
      // instant display when switching back.
      if (previousSid && previousSid !== sid && state.messages.length > 0) {
        const msgSnapshot: Record<string, { info: Message; parts: Record<string, Part> }> = {};
        for (const msg of state.messages) {
          const partsById: Record<string, Part> = {};
          for (const p of msg.parts) {
            partsById[p.id] = p;
          }
          msgSnapshot[msg.info.id] = { info: msg.info, parts: partsById };
        }
        startingBuffers = {
          ...startingBuffers,
          [previousSid]: {
            messages: msgSnapshot,
            hasMore: state.messageHistoryHasMore,
            cursor: state.messageHistoryCursor,
            complete: true,
          },
        };
        // LRU eviction: keep at most MAX_SESSION_BUFFER_CACHE entries.
        // Evict the oldest entries (first keys) when over the limit.
        const bufferKeys = Object.keys(startingBuffers);
        if (bufferKeys.length > MAX_SESSION_BUFFER_CACHE) {
          const evictCount = bufferKeys.length - MAX_SESSION_BUFFER_CACHE;
          const pruned = { ...startingBuffers };
          for (let i = 0; i < evictCount; i++) {
            const key = bufferKeys[i];
            if (key) delete pruned[key];
          }
          startingBuffers = pruned;
        }
      }
      // If we have a buffer for this session, use it for instant display.
      // Incomplete buffers still help for freshly-started sessions while
      // canonical history is loading.
      const buffered = sid ? startingBuffers[sid] : undefined;
      const isCompleteBuffer = !!buffered?.complete;
      let initialMessages: MessageEntry[] = [];
      let restoredHasMore = false;
      let restoredCursor: string | null = null;
      if (buffered) {
        initialMessages = Object.values(buffered.messages).map((entry) => ({
          info: entry.info,
          parts: Object.values(entry.parts).map((p) => tagPartWithDeltaPositions(p)),
        }));
        if (isCompleteBuffer) {
          restoredHasMore = buffered.hasMore;
          restoredCursor = buffered.cursor;
        }
      }
      // Remove consumed complete buffer only. Keep incomplete buffers until
      // canonical history replaces them.
      const { [sid ?? ""]: _consumed, ...remainingBuffers } = startingBuffers;
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
        messages: initialMessages,
        messageHistoryHasMore: restoredHasMore,
        messageHistoryCursor: restoredCursor,
        isLoadingMessages: sid !== null && !!selectedSession && !isCompleteBuffer,
        isLoadingOlderMessages: false,
        isBusy: sid ? state.busySessionIds.has(sid) || hasRunningTurn : false,
        unreadSessionIds: nextUnread,
        activeTargetDirectory: sid ? null : state.activeTargetDirectory,
        activeTargetBackendId: sid ? null : state.activeTargetBackendId,
        _pendingSnapshots: [],
        _sessionBuffers: isCompleteBuffer ? remainingBuffers : startingBuffers,
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

    case "SET_MESSAGES": {
      const mode = action.payload.mode ?? "replace";
      const normalizedMessages = normalizeMessageEntries(action.payload.messages, state.messages);

      if (mode === "prepend") {
        // Deduplicate: remove any incoming messages already in state
        const existingIds = new Set(state.messages.map((m) => m.info.id));
        const newOlder = normalizedMessages.filter((m) => !existingIds.has(m.info.id));
        const combined = [...newOlder, ...state.messages];
        return {
          ...state,
          messages: combined,
          messageHistoryHasMore: action.payload.hasMore,
          messageHistoryCursor: action.payload.nextCursor ?? null,
          isLoadingOlderMessages: false,
        };
      }

      if (mode === "append") {
        const appendIds = new Set(normalizedMessages.map((message) => message.info.id));
        const retainedMessages = state.messages.filter(
          (message) => !appendIds.has(message.info.id),
        );
        const combinedMessages = [...retainedMessages, ...normalizedMessages];
        return {
          ...state,
          messages: limitMessageWindow(combinedMessages),
          messageHistoryHasMore: false,
          messageHistoryCursor: null,
        };
      }

      let replayedState: InternalAgentState = {
        ...state,
        messages: mergeMessageSnapshot(action.payload.messages, state.messages),
        messageHistoryHasMore: action.payload.hasMore,
        messageHistoryCursor: action.payload.nextCursor ?? null,
        isLoadingMessages: false,
        isLoadingOlderMessages: false,
        _pendingSnapshots: [],
      };
      for (const event of state._pendingSnapshots) {
        replayedState = reducer(replayedState, event);
      }
      return replayedState;
    }

    case "PROMPT_SUBMITTED": {
      const message = createOptimisticUserMessage(action.payload);
      if (message.info.sessionID !== state.activeSessionId) {
        return bufferNonActiveEvent(state, message.info.sessionID, message.info.id, () => ({
          info: message.info,
          parts: Object.fromEntries(message.parts.map((part) => [part.id, part])),
        }));
      }
      if (state.messages.some((entry) => entry.info.id === message.info.id)) return state;
      return {
        ...state,
        messages: limitMessageWindow([...state.messages, message]),
      };
    }

    case "SET_LOADING_OLDER_MESSAGES":
      return { ...state, isLoadingOlderMessages: action.payload };

    case "SET_BUSY":
      return { ...state, isBusy: action.payload };

    case "TURN_RUN_STARTED": {
      const run = action.payload;
      const busySessionIds = new Set(state.busySessionIds);
      busySessionIds.add(run.sessionID);
      return {
        ...state,
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
      return { ...state, lastError: action.payload };

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
        loadedBackendId: harnessId,
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
      // Ignore subagent / child sessions - only root sessions appear in the sidebar.
      if (action.payload.parentID) return state;
      // Ignore backend echoes for sessions that were optimistically deleted.
      if (state._deletedSessionIds.has(action.payload.id)) return state;
      const assignedProjectDir = getAssignedProjectDir(state.sessionMeta, action.payload.id);
      const sessionDirectory = normalizeProjectPath(
        (action.payload._projectDir ?? action.payload.directory) || "",
      );
      if (assignedProjectDir && sessionDirectory !== assignedProjectDir) return state;
      const previousActiveSession = state.activeSessionId
        ? state.sessions.find((session) => session.id === state.activeSessionId)
        : null;
      const shouldCanonicalizeActive = previousActiveSession
        ? sameBackendSession(previousActiveSession, action.payload)
        : false;
      return {
        ...state,
        activeSessionId: shouldCanonicalizeActive ? action.payload.id : state.activeSessionId,
        sessions: sortSessionsNewestFirst([
          action.payload,
          ...state.sessions.filter((s) => !sameBackendSession(s, action.payload)),
        ]),
      };
    }

    case "SESSION_UPDATED": {
      const updated = action.payload;
      // Ignore subagent / child sessions - only root sessions appear in the sidebar.
      if (updated.parentID) return state;
      // Ignore backend echoes for sessions that were optimistically deleted.
      // Without this guard the session flickers back into the sidebar
      // between the optimistic removal and the server's session.deleted event.
      if (state._deletedSessionIds.has(updated.id)) return state;
      const assignedProjectDir = getAssignedProjectDir(state.sessionMeta, updated.id);
      const sessionDirectory = normalizeProjectPath(
        (updated._projectDir ?? updated.directory) || "",
      );
      if (assignedProjectDir && sessionDirectory !== assignedProjectDir) return state;
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

      const nextMessages = state.messages.map((m) => {
        if (m.info.sessionID !== oldId) return m;
        return {
          info: { ...m.info, sessionID: newId },
          parts: m.parts.map((p) => ("sessionID" in p ? { ...p, sessionID: newId } : p)),
        };
      });

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

      const nextAfterPart = new Set([...state.afterPartPending].map(renameSessionId));
      const nextAfterPartTriggered = new Set([...state._afterPartTriggered].map(renameSessionId));

      const nextQueued: typeof state.queuedPrompts = {};
      for (const [sid, q] of Object.entries(state.queuedPrompts)) {
        nextQueued[renameSessionId(sid)] = q;
      }

      // Rename the session buffer key if it exists.
      const nextBuffers = { ...state._sessionBuffers };
      if (oldId in nextBuffers) {
        nextBuffers[newId] = nextBuffers[oldId]!;
        delete nextBuffers[oldId];
      }

      return {
        ...state,
        sessions: nextSessions,
        sessionMeta: nextSessionMeta,
        activeSessionId: state.activeSessionId === oldId ? newId : state.activeSessionId,
        messages: nextMessages,
        busySessionIds: nextBusy,
        activeTurnRunBySession: nextActiveTurnRunBySession,
        turnRuns: nextTurnRuns,
        namingSessionIds: nextNaming,
        afterPartPending: nextAfterPart,
        _afterPartTriggered: nextAfterPartTriggered,
        queuedPrompts: nextQueued,
        _sessionBuffers: nextBuffers,
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

      const { [deletedId]: _deletedQueue, ...remainingQueues } = state.queuedPrompts;
      const { [deletedId]: _deletedBuffer, ...remainingBuffers } = state._sessionBuffers;
      const nextUnread = new Set(state.unreadSessionIds);
      nextUnread.delete(deletedId);
      const nextNaming = new Set(state.namingSessionIds);
      nextNaming.delete(deletedId);
      const nextDrafts = { ...state.sessionDrafts };
      delete nextDrafts[`session:${deletedId}`];

      // Clean up child session data for the deleted session.
      // Find child session IDs referenced by the deleted session's parts.
      const deletedSession = state.sessions.find((s) => s.id === deletedId);
      let nextChildSessions = state.childSessions;
      let nextTracked = state.trackedChildSessionIds;
      if (deletedSession) {
        const childIdsToRemove = new Set<string>();
        // Parts are not directly on session, but child sessions tracked in
        // trackedChildSessionIds are keyed by their own IDs. We need to
        // find which children are referenced by this session. Scan the
        // messages that were loaded for this session.
        const sessionMessages = state.activeSessionId === deletedId ? state.messages : [];
        for (const msg of sessionMessages) {
          for (const part of msg.parts) {
            const childSid = getChildSessionId(part);
            if (childSid) {
              childIdsToRemove.add(childSid);
            }
          }
        }
        // Also remove the deleted session itself if tracked as a child
        childIdsToRemove.add(deletedId);

        if (childIdsToRemove.size > 0) {
          nextChildSessions = { ...state.childSessions };
          for (const cid of childIdsToRemove) {
            delete nextChildSessions[cid];
          }
          nextTracked = new Set(state.trackedChildSessionIds);
          for (const cid of childIdsToRemove) {
            nextTracked.delete(cid);
          }
        }
      }

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
        queuedPrompts: remainingQueues,
        _sessionBuffers: remainingBuffers,
        unreadSessionIds: nextUnread,
        namingSessionIds: nextNaming,
        sessionDrafts: nextDrafts,
        sessionMeta: nextSessionMeta,
        _deletedSessionIds: nextDeleted,
        childSessions: nextChildSessions,
        trackedChildSessionIds: nextTracked,
        ...(state.activeSessionId === deletedId
          ? {
              activeSessionId: null,
              messages: [],
              messageHistoryHasMore: false,
              messageHistoryCursor: null,
              isLoadingOlderMessages: false,
              isBusy: false,
            }
          : {}),
      };
    }

    case "MESSAGE_UPDATED": {
      const msg = action.payload;
      const turnPatch = bindAssistantMessageToActiveTurn(state, msg) ?? {};
      if (msg.sessionID !== state.activeSessionId) {
        return {
          ...bufferNonActiveEvent(state, msg.sessionID, msg.id, (entry) => ({
            ...entry,
            info: msg,
          })),
          ...turnPatch,
        };
      }
      // Queue snapshot if messages are still loading from the server
      if (state.isLoadingMessages) {
        return {
          ...state,
          ...turnPatch,
          _pendingSnapshots: [...state._pendingSnapshots, action],
        };
      }
      const existsInWindow = state.messages.some((m) => m.info.id === msg.id);
      if (existsInWindow) {
        return {
          ...state,
          ...turnPatch,
          messages: state.messages.map((m) => (m.info.id === msg.id ? { ...m, info: msg } : m)),
        };
      }

      const appendedMessages = limitMessageWindow([...state.messages, { info: msg, parts: [] }]);
      const didTrim = appendedMessages.length < state.messages.length + 1;
      return {
        ...state,
        ...turnPatch,
        messages: appendedMessages,
        // If limitMessageWindow trimmed messages, older history exists
        ...(didTrim ? { messageHistoryHasMore: true } : {}),
      };
    }

    case "MESSAGE_REPLACED": {
      const { sessionID, oldId, message, parts } = action.payload;
      const activeTurnId = state.activeTurnRunBySession[sessionID];
      const activeTurn = activeTurnId ? state.turnRuns[activeTurnId] : undefined;
      const turnPatch =
        activeTurn?.assistantMessageID === oldId
          ? {
              turnRuns: {
                ...state.turnRuns,
                [activeTurn.id]: { ...activeTurn, assistantMessageID: message.id },
              },
            }
          : {};
      const replacement = { info: message, parts };
      const replaceEntries = (entries: MessageEntry[]) => {
        let replaced = false;
        const next = entries
          .filter((entry) => entry.info.id !== message.id)
          .map((entry) => {
            if (entry.info.id !== oldId) return entry;
            replaced = true;
            return replacement;
          });
        return replaced ? next : [...next, replacement];
      };

      if (sessionID === state.activeSessionId && state.isLoadingMessages) {
        return {
          ...state,
          ...turnPatch,
          _pendingSnapshots: [...state._pendingSnapshots, action],
        };
      }
      if (sessionID !== state.activeSessionId) {
        const sessionBuffer = state._sessionBuffers[sessionID];
        if (!sessionBuffer) return { ...state, ...turnPatch };
        const { [oldId]: _old, [message.id]: _existing, ...remaining } = sessionBuffer.messages;
        return {
          ...state,
          ...turnPatch,
          _sessionBuffers: {
            ...state._sessionBuffers,
            [sessionID]: {
              ...sessionBuffer,
              messages: {
                ...remaining,
                [message.id]: {
                  info: message,
                  parts: Object.fromEntries(parts.map((part) => [part.id, part])),
                },
              },
            },
          },
        };
      }

      return {
        ...state,
        ...turnPatch,
        messages: limitMessageWindow(replaceEntries(state.messages)),
      };
    }

    case "PART_UPDATED": {
      const { part } = action.payload;
      if (part.sessionID !== state.activeSessionId) {
        return bufferNonActiveEvent(state, part.sessionID, part.messageID, (entry) => {
          const previous = entry.parts[part.id];
          const tagged = tagPartWithDeltaPositions(part, previous);
          return {
            ...entry,
            parts: { ...entry.parts, [part.id]: tagged },
          };
        });
      }
      // Track child session IDs from Task tool parts with metadata.sessionId
      let childTrackPatch:
        | {
            trackedChildSessionIds: Set<string>;
            childSessions: typeof state.childSessions;
          }
        | undefined;
      const childSid = getChildSessionId(part);
      if (childSid && !state.trackedChildSessionIds.has(childSid)) {
        const nextTracked = new Set(state.trackedChildSessionIds);
        nextTracked.add(childSid);
        childTrackPatch = {
          trackedChildSessionIds: nextTracked,
          childSessions: {
            ...state.childSessions,
            [childSid]: state.childSessions[childSid] ?? {},
          },
        };
      }
      // Queue snapshot if messages are still loading from the server
      if (state.isLoadingMessages) {
        return {
          ...state,
          ...childTrackPatch,
          _pendingSnapshots: [...state._pendingSnapshots, action],
        };
      }

      const updateEntry = (entry?: MessageEntry): MessageEntry => {
        const currentEntry = entry ?? createPlaceholderMessageEntry(part.sessionID, part.messageID);
        const existingIdx = currentEntry.parts.findIndex((p) => p.id === part.id);
        const previous = existingIdx >= 0 ? currentEntry.parts[existingIdx] : undefined;
        const tagged = mergeSnapshotPartWithExisting(part, previous);
        const newParts = [...currentEntry.parts];
        if (existingIdx >= 0) newParts[existingIdx] = tagged;
        else newParts.push(tagged);
        return { ...currentEntry, parts: newParts };
      };

      const sourceEntry = state.messages.find((m) => m.info.id === part.messageID);
      const prevPart = sourceEntry?.parts.find((p) => p.id === part.id);
      const updatedWindow = updateMessageArray(state.messages, part.messageID, updateEntry);

      // After-part trigger: detect when a part just finished while we're
      // waiting for the current part to complete before aborting + sending.
      let afterPartPatch:
        | {
            afterPartPending: Set<string>;
            _afterPartTriggered: Set<string>;
          }
        | undefined;
      if (state.afterPartPending.has(part.sessionID)) {
        let justFinished = false;

        if (part.type === "tool") {
          const doneStatus = part.state.status === "completed" || part.state.status === "error";
          const wasPending =
            !prevPart ||
            (prevPart.type === "tool" &&
              (prevPart.state.status === "running" || prevPart.state.status === "pending"));
          justFinished = doneStatus && wasPending;
        } else if (part.type === "text") {
          const hasEnd = part.time?.end !== undefined;
          const prevHadEnd = prevPart?.type === "text" && prevPart.time?.end !== undefined;
          justFinished = hasEnd && !prevHadEnd;
        } else if (part.type === "step-finish") {
          // StepFinishPart arrival always signals a step boundary
          justFinished = !prevPart;
        }

        if (justFinished) {
          const nextPending = new Set(state.afterPartPending);
          nextPending.delete(part.sessionID);
          const nextTriggered = new Set(state._afterPartTriggered);
          nextTriggered.add(part.sessionID);
          afterPartPatch = {
            afterPartPending: nextPending,
            _afterPartTriggered: nextTriggered,
          };
        }
      }

      const canonicalEntry = updatedWindow.messages.find((m) => m.info.id === part.messageID);
      const dedupedMessages = canonicalEntry
        ? removeMatchingOptimisticUserMessage(updatedWindow.messages, canonicalEntry)
        : updatedWindow.messages;
      const partUpdatedMessages = limitMessageWindow(dedupedMessages);
      const partDidTrim = partUpdatedMessages.length < dedupedMessages.length;
      return {
        ...state,
        ...childTrackPatch,
        ...afterPartPatch,
        messages: partUpdatedMessages,
        // If limitMessageWindow trimmed messages, older history exists
        ...(partDidTrim ? { messageHistoryHasMore: true } : {}),
      };
    }

    case "PART_DELTA": {
      const { sessionID, messageID, partID, field, delta } = action.payload;
      if (sessionID !== state.activeSessionId) {
        return bufferNonActiveEvent(state, sessionID, messageID, (entry) => {
          const existing =
            entry.parts[partID] ?? createPlaceholderPart(sessionID, messageID, partID, field);
          const nextPart = applyStreamingDeltaToPart(existing, field, delta);
          return {
            ...entry,
            parts: { ...entry.parts, [partID]: nextPart },
          };
        });
      }

      if (state.isLoadingMessages) {
        return {
          ...state,
          _pendingSnapshots: [...state._pendingSnapshots, action],
        };
      }

      const updateEntry = (entry?: MessageEntry): MessageEntry => {
        const current = entry ?? createPlaceholderMessageEntry(sessionID, messageID);
        const partIndex = current.parts.findIndex((p) => p.id === partID);
        const existingPart = partIndex >= 0 ? current.parts[partIndex] : undefined;
        const existing = existingPart ?? createPlaceholderPart(sessionID, messageID, partID, field);
        const nextPart = applyStreamingDeltaToPart(existing, field, delta);
        const nextParts = [...current.parts];
        if (partIndex >= 0) nextParts[partIndex] = nextPart;
        else nextParts.push(nextPart);
        return { ...current, parts: nextParts };
      };
      const deltaUpdated = updateMessageArray(state.messages, messageID, updateEntry).messages;
      const deltaMessages = limitMessageWindow(deltaUpdated);
      const deltaDidTrim = deltaMessages.length < deltaUpdated.length;
      return {
        ...state,
        messages: deltaMessages,
        // If limitMessageWindow trimmed messages, older history exists
        ...(deltaDidTrim ? { messageHistoryHasMore: true } : {}),
      };
    }

    case "PART_REMOVED": {
      const { sessionID, messageID, partID } = action.payload;
      if (sessionID === state.activeSessionId && state.isLoadingMessages) {
        return {
          ...state,
          _pendingSnapshots: [...state._pendingSnapshots, action],
        };
      }
      if (sessionID !== state.activeSessionId) {
        // Handle removal for tracked child sessions
        if (state.trackedChildSessionIds.has(sessionID)) {
          const childBuf = state.childSessions[sessionID];
          if (!childBuf) return state;
          const entry = childBuf[messageID];
          if (!entry || !(partID in entry.parts)) return state;
          const { [partID]: _removedChild, ...remainingChildParts } = entry.parts;
          return {
            ...state,
            childSessions: {
              ...state.childSessions,
              [sessionID]: {
                ...childBuf,
                [messageID]: {
                  ...entry,
                  parts: remainingChildParts,
                },
              },
            },
          };
        }
        const sessionBuffer = state._sessionBuffers[sessionID];
        if (!sessionBuffer) return state;
        const entry = sessionBuffer.messages[messageID];
        if (!entry || !(partID in entry.parts)) return state;
        const { [partID]: _removed, ...remainingParts } = entry.parts;
        const newBuffers = { ...state._sessionBuffers };
        newBuffers[sessionID] = {
          ...sessionBuffer,
          messages: {
            ...sessionBuffer.messages,
            [messageID]: { ...entry, parts: remainingParts },
          },
        };
        return { ...state, _sessionBuffers: newBuffers };
      }
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.info.id !== messageID) return m;
          return {
            ...m,
            parts: m.parts.filter((p) => p.id !== partID),
          };
        }),
      };
    }

    case "MESSAGE_REMOVED": {
      const { sessionID, messageID } = action.payload;
      if (sessionID === state.activeSessionId && state.isLoadingMessages) {
        return {
          ...state,
          _pendingSnapshots: [...state._pendingSnapshots, action],
        };
      }
      if (sessionID !== state.activeSessionId) {
        // Handle removal for tracked child sessions
        if (state.trackedChildSessionIds.has(sessionID)) {
          const childBuf = state.childSessions[sessionID];
          if (!childBuf) return state;
          if (!(messageID in childBuf)) return state;
          const { [messageID]: _removedMsg, ...remainingChildMsgs } = childBuf;
          return {
            ...state,
            childSessions: {
              ...state.childSessions,
              [sessionID]: remainingChildMsgs,
            },
          };
        }
        const sessionBuffer = state._sessionBuffers[sessionID];
        if (!sessionBuffer) return state;
        if (!(messageID in sessionBuffer.messages)) return state;
        const { [messageID]: _removed, ...remainingMsgs } = sessionBuffer.messages;
        const newBuffers = { ...state._sessionBuffers };
        newBuffers[sessionID] = {
          ...sessionBuffer,
          messages: remainingMsgs,
        };
        return { ...state, _sessionBuffers: newBuffers };
      }
      return {
        ...state,
        messages: state.messages.filter((m) => m.info.id !== messageID),
      };
    }

    case "SESSION_STATUS": {
      const { sessionID, status } = action.payload;
      const isBusy = status.type === "busy";
      const newBusy = new Set(state.busySessionIds);
      if (isBusy) {
        newBusy.add(sessionID);
      } else {
        newBusy.delete(sessionID);
      }
      // Keep session buffer cached even when session goes idle so
      // switching back to it is instant (LRU eviction handles cleanup).
      const nextBuffers = state._sessionBuffers;
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
        unreadSessionIds: nextUnread,
        _sessionBuffers: nextBuffers,
        ...(sessionID === state.activeSessionId && !isBusy
          ? { messages: finalizeRunningToolPartsForSession(state.messages, sessionID) }
          : {}),
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
      const nextBuffers = state._sessionBuffers;
      return {
        ...state,
        busySessionIds: newBusy,
        _sessionBuffers: nextBuffers,
        ...(state.activeSessionId && statuses[state.activeSessionId]
          ? {
              isBusy: statuses[state.activeSessionId]?.type === "busy",
            }
          : {}),
      };
    }

    case "SET_SESSION_QUEUE": {
      const { sessionID, prompts } = action.payload;
      if (prompts.length === 0) {
        const { [sessionID]: _, ...rest } = state.queuedPrompts;
        return { ...state, queuedPrompts: rest };
      }
      return {
        ...state,
        queuedPrompts: {
          ...state.queuedPrompts,
          [sessionID]: prompts,
        },
      };
    }

    case "QUEUE_ADD": {
      const { sessionID, prompt } = action.payload;
      const existing = state.queuedPrompts[sessionID] ?? [];
      return {
        ...state,
        queuedPrompts: {
          ...state.queuedPrompts,
          [sessionID]: [...existing, prompt],
        },
      };
    }

    case "QUEUE_SHIFT": {
      const { sessionID } = action.payload;
      const existing = state.queuedPrompts[sessionID] ?? [];
      if (existing.length <= 1) {
        const { [sessionID]: _, ...rest } = state.queuedPrompts;
        return { ...state, queuedPrompts: rest };
      }
      return {
        ...state,
        queuedPrompts: {
          ...state.queuedPrompts,
          [sessionID]: existing.slice(1),
        },
      };
    }

    case "QUEUE_REMOVE": {
      const { sessionID, promptID } = action.payload;
      const existing = state.queuedPrompts[sessionID] ?? [];
      if (existing.length === 0) return state;
      const next = existing.filter((item) => item.id !== promptID);
      if (next.length === existing.length) return state;
      if (next.length === 0) {
        const { [sessionID]: _, ...rest } = state.queuedPrompts;
        return { ...state, queuedPrompts: rest };
      }
      return {
        ...state,
        queuedPrompts: {
          ...state.queuedPrompts,
          [sessionID]: next,
        },
      };
    }

    case "QUEUE_REORDER": {
      const { sessionID, fromIndex, toIndex } = action.payload;
      const existing = state.queuedPrompts[sessionID] ?? [];
      if (existing.length <= 1) return state;
      if (fromIndex < 0 || fromIndex >= existing.length) return state;

      const clampedTo = Math.max(0, Math.min(toIndex, existing.length - 1));
      if (clampedTo === fromIndex) return state;

      const next = [...existing];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return state;
      next.splice(clampedTo, 0, moved);

      return {
        ...state,
        queuedPrompts: {
          ...state.queuedPrompts,
          [sessionID]: next,
        },
      };
    }

    case "QUEUE_UPDATE": {
      const { sessionID, promptID, text } = action.payload;
      const existing = state.queuedPrompts[sessionID] ?? [];
      if (existing.length === 0) return state;

      let changed = false;
      const next = existing.map((item) => {
        if (item.id !== promptID) return item;
        if (item.text === text) return item;
        changed = true;
        return { ...item, text };
      });

      if (!changed) return state;
      return {
        ...state,
        queuedPrompts: {
          ...state.queuedPrompts,
          [sessionID]: next,
        },
      };
    }

    case "QUEUE_CLEAR": {
      const { sessionID } = action.payload;
      const { [sessionID]: _, ...rest } = state.queuedPrompts;
      return { ...state, queuedPrompts: rest };
    }

    case "SET_AFTER_PART_PENDING": {
      const { sessionID, pending } = action.payload;
      const next = new Set(state.afterPartPending);
      if (pending) {
        next.add(sessionID);
      } else {
        next.delete(sessionID);
      }
      return { ...state, afterPartPending: next };
    }

    case "CLEAR_AFTER_PART_TRIGGERED": {
      const { sessionID } = action.payload;
      const next = new Set(state._afterPartTriggered);
      next.delete(sessionID);
      return { ...state, _afterPartTriggered: next };
    }

    case "SET_DEFAULT_CHAT_DIRECTORY":
      return { ...state, defaultChatDirectory: action.payload };

    case "SET_ACTIVE_TARGET":
      return {
        ...state,
        activeTargetDirectory: action.payload.directory,
        activeTargetBackendId: action.payload.harnessId,
        activeSessionId: null,
        messages: [],
        messageHistoryHasMore: false,
        messageHistoryCursor: null,
        isLoadingMessages: false,
        isLoadingOlderMessages: false,
        isBusy: false,
      };

    case "CLEAR_ACTIVE_TARGET":
      return {
        ...state,
        activeTargetDirectory: null,
        activeTargetBackendId: null,
      };

    case "SET_SESSION_META": {
      const { sessionId, meta } = action.payload;
      const nextMeta = { ...state.sessionMeta };
      const existing = nextMeta[sessionId] ?? {};
      nextMeta[sessionId] = { ...existing, ...meta };
      persistSessionMetaMap(nextMeta);
      return { ...state, sessionMeta: nextMeta };
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

    case "LOAD_CHILD_SESSION": {
      const { childSessionId, messages } = action.payload;
      const existingChildBuf = state.childSessions[childSessionId] ?? {};
      const childBuf: Record<string, { info: Message; parts: Record<string, Part> }> = {
        ...existingChildBuf,
      };
      for (const msg of messages) {
        const previousEntry = existingChildBuf[msg.info.id];
        const partsById: Record<string, Part> = previousEntry ? { ...previousEntry.parts } : {};
        for (const p of msg.parts) {
          partsById[p.id] = p;
        }
        childBuf[msg.info.id] = {
          info: msg.info,
          parts: partsById,
        };
      }
      const nextTracked = new Set(state.trackedChildSessionIds);
      nextTracked.add(childSessionId);
      return {
        ...state,
        trackedChildSessionIds: nextTracked,
        childSessions: {
          ...state.childSessions,
          [childSessionId]: childBuf,
        },
      };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Child session helpers
// ---------------------------------------------------------------------------

/**
 * Collect all renderable parts (text + tool) from a child (subagent) session,
 * preserving transcript order. Excludes user-role messages.
 */
