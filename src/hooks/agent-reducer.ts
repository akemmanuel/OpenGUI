import type {
  Agent,
  Command,
  Message,
  Part,
  PermissionRequest,
  Provider,
  QuestionRequest,
  Session,
} from "@opencode-ai/sdk/v2/client";
import type { AgentBackendId } from "@/agents";
import type { InternalAgentState, MessageEntry, QueuedPrompt } from "@/hooks/use-agent-impl-core";
import {
  applyStreamingDeltaToPart,
  bufferNonActiveEvent,
  createPlaceholderMessageEntry,
  createPlaceholderPart,
  getChildSessionId,
  limitMessageWindow,
  MAX_SESSION_BUFFER_CACHE,
  mergeSnapshotPartWithExisting,
  normalizeMessageEntries,
  tagPartWithDeltaPositions,
  updateMessageArray,
} from "@/hooks/agent-message-state";
import {
  getSessionSelectedAgent,
  getSessionSelectedModel,
  getSessionSelectedVariant,
  getSessionWorkspaceId,
  parseProjectKey,
  sortSessionsNewestFirst,
} from "@/hooks/agent-session-utils";
import {
  getStoredDefaultChatDirectory,
  normalizeWorkspace,
  persistProjectMetaMap,
  persistSessionMetaMap,
  persistWorktreeParents,
  type ProjectMeta,
  type RecentProject,
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

const MAX_DELETED_SESSION_IDS = 200;

function isModelAvailable(providers: Provider[], model: SelectedModel | null) {
  if (!model) return false;
  const provider = providers.find((item) => item.id === model.providerID);
  return Boolean(provider?.models?.[model.modelID]);
}

function isAgentAvailable(agents: Agent[], agent: string | null | undefined) {
  if (!agent) return true;
  return agents.some((item) => item.name === agent);
}

function selectedModelsEqual(
  a: SelectedModel | null | undefined,
  b: SelectedModel | null | undefined,
) {
  return a?.providerID === b?.providerID && a?.modelID === b?.modelID;
}

type Action =
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
      type: "REORDER_WORKSPACE_PROJECTS";
      payload: { workspaceId: string; fromIndex: number; toIndex: number };
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
  | { type: "CLEAR_ALL_PROJECTS" }
  | { type: "SET_SESSIONS"; payload: Session[] }
  | {
      type: "MERGE_PROJECT_SESSIONS";
      payload: { projectKey: string; directory: string; sessions: Session[] };
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
  | { type: "SET_LOADING_OLDER_MESSAGES"; payload: boolean }
  | { type: "SET_LOADING_NEWER_MESSAGES"; payload: boolean }
  | { type: "SET_BUSY"; payload: boolean }
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
  | { type: "SET_RECENT_PROJECTS"; payload: RecentProject[] }
  | { type: "SET_HOME_DIRECTORY"; payload: string | null }
  | { type: "SET_DEFAULT_CHAT_DIRECTORY"; payload: string | null }
  | {
      type: "START_DRAFT_SESSION";
      payload: { directory: string; backendId: AgentBackendId };
    }
  | { type: "SET_DRAFT_DIRECTORY"; payload: string }
  | { type: "SET_DRAFT_BACKEND"; payload: AgentBackendId }
  | { type: "CLEAR_DRAFT_SESSION" }
  | { type: "SET_DRAFT_TEMPORARY"; payload: boolean }
  | { type: "MARK_SESSION_TEMPORARY"; payload: string }
  | { type: "UNMARK_SESSION_TEMPORARY"; payload: string }
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
  | { type: "TOUCH_WORKTREE"; payload: string }
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

    case "SET_ACTIVE_WORKSPACE":
      return { ...state, activeWorkspaceId: action.payload };

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

    case "REORDER_WORKSPACE_PROJECTS": {
      const { workspaceId, fromIndex, toIndex } = action.payload;
      let changed = false;
      const nextWorkspaces = state.workspaces.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;
        const projects = workspace.projects ?? [];
        if (projects.length <= 1) return workspace;
        if (fromIndex < 0 || fromIndex >= projects.length) return workspace;
        const clampedTo = Math.max(0, Math.min(toIndex, projects.length - 1));
        if (clampedTo === fromIndex) return workspace;
        const nextProjects = [...projects];
        const [moved] = nextProjects.splice(fromIndex, 1);
        if (!moved) return workspace;
        nextProjects.splice(clampedTo, 0, moved);
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
      return {
        ...state,
        connections: { ...state.connections, [projectKey]: status },
      };
    }

    case "REMOVE_PROJECT": {
      const { projectKey, directory } = action.payload;
      const { workspaceId } = parseProjectKey(projectKey);
      const removedSessionIds = new Set(
        state.sessions
          .filter(
            (s) =>
              getSessionWorkspaceId(s) === workspaceId &&
              (s._projectDir ?? s.directory) === directory,
          )
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
      const nextSessionMeta = { ...state.sessionMeta };
      let didPruneSessionMeta = false;
      for (const sessionId of removedSessionIds) {
        if (!(sessionId in nextSessionMeta)) continue;
        delete nextSessionMeta[sessionId];
        didPruneSessionMeta = true;
      }
      if (didPruneSessionMeta) {
        persistSessionMetaMap(nextSessionMeta);
      }

      const nextNaming = new Set(state.namingSessionIds);
      for (const sessionId of removedSessionIds) {
        nextNaming.delete(sessionId);
      }

      return {
        ...state,
        workspaces: nextWorkspaces,
        sessionMeta: nextSessionMeta,
        projectMeta: nextProjectMeta,
        connections: rest,
        projectWorkspaceMap: restProjectWorkspaceMap,
        sessions: state.sessions.filter(
          (s) =>
            !(
              getSessionWorkspaceId(s) === workspaceId &&
              (s._projectDir ?? s.directory) === directory
            ),
        ),
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
              messageForwardBuffer: [],
              messageHistoryHasMore: false,
              messageHistoryCursor: null,
              messageWindowHasNewer: false,
              isLoadingOlderMessages: false,
              isLoadingNewerMessages: false,
              isBusy: false,
            }
          : {}),
        // Clear draft if it belongs to the removed project
        draftSessionDirectory:
          state.draftSessionDirectory === directory ? null : state.draftSessionDirectory,
        draftSessionBackendId:
          state.draftSessionDirectory === directory ? null : state.draftSessionBackendId,
      };
    }

    case "CLEAR_ALL_PROJECTS":
      return {
        ...state,
        connections: {},
        projectWorkspaceMap: {},
        sessions: [],
        activeSessionId: null,
        messages: [],
        messageForwardBuffer: [],
        messageHistoryHasMore: false,
        messageHistoryCursor: null,
        messageWindowHasNewer: false,
        isLoadingMessages: false,
        isLoadingOlderMessages: false,
        isLoadingNewerMessages: false,
        isBusy: false,
        pendingPermissions: {},
        pendingQuestions: {},
        busySessionIds: new Set(),
        temporarySessions: new Set(),
        namingSessionIds: new Set(),
        childSessions: {},
        trackedChildSessionIds: new Set(),
        _pendingSnapshots: [],
        _sessionBuffers: {},
        afterPartPending: new Set(),
        _afterPartTriggered: new Set(),
        _deletedSessionIds: new Set(),
        draftSessionDirectory: null,
        draftSessionBackendId: null,
        draftIsTemporary: false,
      };

    case "SET_SESSIONS":
      return { ...state, sessions: sortSessionsNewestFirst(action.payload) };

    case "SET_BOOT_STATE": {
      return {
        ...state,
        bootState: action.payload.state,
        bootError: action.payload.error ?? null,
        bootLogs: action.payload.logs ?? null,
      };
    }

    case "MERGE_PROJECT_SESSIONS": {
      const { projectKey, directory, sessions } = action.payload;
      const { workspaceId } = parseProjectKey(projectKey);
      const filtered = state.sessions.filter(
        (s) =>
          !(
            getSessionWorkspaceId(s) === workspaceId && (s._projectDir ?? s.directory) === directory
          ),
      );
      // Deduplicate by session ID: if the incoming batch contains a
      // session that already exists under a *different* project
      // directory (possible when directories share the same git repo /
      // project_id on the server), keep the existing one and skip the
      // duplicate from the new batch.
      const existingIds = new Set(filtered.map((s) => s.id));
      const deduped = sessions.filter((s) => !existingIds.has(s.id));
      return {
        ...state,
        sessions: sortSessionsNewestFirst([...filtered, ...deduped]),
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
              lastActiveSessionId: sid ?? workspace.lastActiveSessionId,
            }
          : workspace,
      );
      return {
        ...state,
        workspaces: nextWorkspaces,
        activeSessionId: sid,
        selectedModel: nextSelectedModel,
        selectedAgent: nextSelectedAgent,
        variantSelections: nextVariantSelections,
        messages: initialMessages,
        messageForwardBuffer: [],
        messageHistoryHasMore: restoredHasMore,
        messageHistoryCursor: restoredCursor,
        messageWindowHasNewer: false,
        isLoadingMessages: sid !== null && !isCompleteBuffer,
        isLoadingOlderMessages: false,
        isLoadingNewerMessages: false,
        isBusy: sid ? state.busySessionIds.has(sid) : false,
        unreadSessionIds: nextUnread,
        // Selecting a real session clears any pending draft
        draftSessionDirectory: sid ? null : state.draftSessionDirectory,
        draftSessionBackendId: sid ? null : state.draftSessionBackendId,
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
          messageForwardBuffer: [],
          messageHistoryHasMore: false,
          messageHistoryCursor: null,
          messageWindowHasNewer: false,
          isLoadingNewerMessages: false,
        };
      }

      const existingByMsgId = new Map<string, MessageEntry>();
      for (const message of state.messages) {
        existingByMsgId.set(message.info.id, message);
      }

      if (normalizedMessages.length > 0) {
        const serverLast = normalizedMessages[normalizedMessages.length - 1];
        const serverLastCreated = serverLast?.info.time.created ?? 0;
        const incomingIds = new Set(action.payload.messages.map((message) => message.info.id));
        for (const [id, entry] of existingByMsgId) {
          if (incomingIds.has(id)) continue;
          const entryCreated = entry.info.time.created ?? 0;
          if (entryCreated > serverLastCreated) {
            normalizedMessages.push(entry);
          }
        }
      }

      let replayedState: InternalAgentState = {
        ...state,
        messages: limitMessageWindow(normalizedMessages),
        messageForwardBuffer: [],
        messageHistoryHasMore: action.payload.hasMore,
        messageHistoryCursor: action.payload.nextCursor ?? null,
        messageWindowHasNewer: false,
        isLoadingMessages: false,
        isLoadingOlderMessages: false,
        isLoadingNewerMessages: false,
        _pendingSnapshots: [],
      };
      for (const event of state._pendingSnapshots) {
        replayedState = reducer(replayedState, event);
      }
      return replayedState;
    }

    case "SET_LOADING_OLDER_MESSAGES":
      return { ...state, isLoadingOlderMessages: action.payload };

    case "SET_LOADING_NEWER_MESSAGES":
      return { ...state, isLoadingNewerMessages: action.payload };

    case "SET_BUSY":
      return { ...state, isBusy: action.payload };

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

    case "SET_VARIANT_SELECTIONS":
      return { ...state, variantSelections: action.payload };

    case "SESSION_CREATED": {
      // Ignore subagent / child sessions - only root sessions appear in the sidebar.
      if (action.payload.parentID) return state;
      // Ignore backend echoes for sessions that were optimistically deleted.
      if (state._deletedSessionIds.has(action.payload.id)) return state;
      return {
        ...state,
        sessions: sortSessionsNewestFirst([
          action.payload,
          ...state.sessions.filter((s) => s.id !== action.payload.id),
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
      const exists = state.sessions.some((s) => s.id === updated.id);
      // Update in-place without re-sorting to prevent the sidebar from
      // jumping around while sessions receive streaming updates.
      return {
        ...state,
        sessions: exists
          ? state.sessions.map((s) => (s.id === updated.id ? updated : s))
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
      const nextTemp = new Set(state.temporarySessions);
      nextTemp.delete(deletedId);
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
        temporarySessions: nextTemp,
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
              messageForwardBuffer: [],
              messageHistoryHasMore: false,
              messageHistoryCursor: null,
              messageWindowHasNewer: false,
              isLoadingOlderMessages: false,
              isLoadingNewerMessages: false,
              isBusy: false,
            }
          : {}),
      };
    }

    case "MESSAGE_UPDATED": {
      const msg = action.payload;
      if (msg.sessionID !== state.activeSessionId) {
        return bufferNonActiveEvent(state, msg.sessionID, msg.id, (entry) => ({
          ...entry,
          info: msg,
        }));
      }
      // Queue snapshot if messages are still loading from the server
      if (state.isLoadingMessages) {
        return {
          ...state,
          _pendingSnapshots: [...state._pendingSnapshots, action],
        };
      }
      const existsInWindow = state.messages.some((m) => m.info.id === msg.id);
      if (existsInWindow) {
        return {
          ...state,
          messages: state.messages.map((m) => (m.info.id === msg.id ? { ...m, info: msg } : m)),
        };
      }

      const appendedMessages = limitMessageWindow([...state.messages, { info: msg, parts: [] }]);
      const didTrim = appendedMessages.length < state.messages.length + 1;
      return {
        ...state,
        messages: appendedMessages,
        messageForwardBuffer: [],
        // If limitMessageWindow trimmed messages, older history exists
        ...(didTrim ? { messageHistoryHasMore: true } : {}),
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

      const partUpdatedMessages = limitMessageWindow(updatedWindow.messages);
      const partDidTrim = partUpdatedMessages.length < updatedWindow.messages.length;
      return {
        ...state,
        ...childTrackPatch,
        ...afterPartPatch,
        messages: partUpdatedMessages,
        messageForwardBuffer: [],
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
        messageForwardBuffer: [],
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
        messageForwardBuffer: [],
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
        messageForwardBuffer: [],
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
      return {
        ...state,
        busySessionIds: newBusy,
        unreadSessionIds: nextUnread,
        _sessionBuffers: nextBuffers,
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

    case "SET_RECENT_PROJECTS":
      return { ...state, recentProjects: action.payload };

    case "SET_HOME_DIRECTORY": {
      const defaultChatDirectory =
        getStoredDefaultChatDirectory() ??
        (action.payload ? normalizeProjectPath(action.payload) : null);
      return {
        ...state,
        homeDirectory: action.payload,
        defaultChatDirectory,
      };
    }

    case "SET_DEFAULT_CHAT_DIRECTORY":
      return { ...state, defaultChatDirectory: action.payload };

    case "START_DRAFT_SESSION":
      return {
        ...state,
        draftSessionDirectory: action.payload.directory,
        draftSessionBackendId: action.payload.backendId,
        activeSessionId: null,
        messages: [],
        messageForwardBuffer: [],
        messageHistoryHasMore: false,
        messageHistoryCursor: null,
        messageWindowHasNewer: false,
        isLoadingMessages: false,
        isLoadingOlderMessages: false,
        isLoadingNewerMessages: false,
        isBusy: false,
      };

    case "SET_DRAFT_DIRECTORY":
      return {
        ...state,
        draftSessionDirectory: action.payload,
      };

    case "SET_DRAFT_BACKEND":
      return { ...state, draftSessionBackendId: action.payload };

    case "CLEAR_DRAFT_SESSION":
      return {
        ...state,
        draftSessionDirectory: null,
        draftSessionBackendId: null,
        draftIsTemporary: false,
      };

    case "SET_DRAFT_TEMPORARY":
      return { ...state, draftIsTemporary: action.payload };

    case "MARK_SESSION_TEMPORARY": {
      const next = new Set(state.temporarySessions);
      next.add(action.payload);
      return { ...state, temporarySessions: next };
    }

    case "UNMARK_SESSION_TEMPORARY": {
      const next = new Set(state.temporarySessions);
      next.delete(action.payload);
      return { ...state, temporarySessions: next };
    }

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

    case "TOUCH_WORKTREE": {
      const existing = state.worktreeParents[action.payload];
      if (!existing) return state;
      const next: WorktreeParentMap = {
        ...state.worktreeParents,
        [action.payload]: {
          ...existing,
          lastOpenedAt: new Date().toISOString(),
        },
      };
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
