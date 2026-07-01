import type { Message } from "@/protocol/harness-types";
import type { InternalAgentState, Session } from "@/hooks/agent-state-types";
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
  parseProjectKey,
} from "@/hooks/agent-session-utils";
import { persistSessionMetaMap } from "@/hooks/agent-state-persistence";
import { updateVariantSelections, variantKey } from "@/hooks/use-agent-variant-core";
import { harnessSessionIdentity, sameHarnessSessionIdentity } from "@/lib/session-identity";
import {
  isAgentAvailable,
  isModelAvailable,
  selectedModelsEqual,
} from "@/hooks/agent-model-selection";
import {
  pickQueuePresentationSlice,
  removeSessionFromQueueSlice,
  renameSessionIdInQueueSlice,
} from "@/hooks/agent-reducer-queue-slice";
import type { Action } from "@/hooks/agent-reducer-types";

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

function touchLiveSessionRetain(
  liveSessionRetainUntil: InternalAgentState["liveSessionRetainUntil"],
  sessionId: string,
): InternalAgentState["liveSessionRetainUntil"] {
  return { ...liveSessionRetainUntil, [sessionId]: nextLiveSessionRetainUntil() };
}

function markDefaultChatListedSessions({
  current,
  sessions,
}: {
  current: InternalAgentState["sessionMeta"];
  sessions: Session[];
}) {
  let changed = false;
  const next = { ...current };
  for (const session of sessions) {
    if (!session?.id) continue;
    const existing = next[session.id];
    if (existing?.sidebarSection) continue;
    next[session.id] = {
      ...existing,
      sidebarSection: "chats",
      displayProjectDir: null,
    };
    changed = true;
  }
  return changed ? next : current;
}

const SESSION_ACTIVITY_ACTION_TYPES = new Set<string>([
  "BIND_ASSISTANT_TURN_FROM_TRANSCRIPT",
  "CLEAR_SESSION_DRAFT",
  "INIT_BUSY_SESSIONS",
  "MERGE_PROJECT_SESSIONS",
  "SESSION_CREATED",
  "SESSION_DELETED",
  "SESSION_ERROR",
  "SESSION_REPLACED",
  "SESSION_STATUS",
  "SESSION_UPDATED",
  "SET_ACTIVE_SESSION",
  "SET_BOOT_STATE",
  "SET_BUSY",
  "SET_ERROR",
  "SET_PERMISSION",
  "SET_QUESTION",
  "SET_SESSION_DRAFT",
  "SET_SESSION_META",
  "SET_SESSION_NAMING",
  "TURN_RUN_STARTED",
]);

export function isSessionActivityReducerAction(action: Action): boolean {
  return SESSION_ACTIVITY_ACTION_TYPES.has(action.type);
}

/** Phase C2: merge, selection, busy/status, queue patches, permissions, SESSION_*, transcript turn bind. */
export function reduceSessionActivitySlice(
  state: InternalAgentState,
  action: Action,
): InternalAgentState {
  switch (action.type) {
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
          ? markDefaultChatListedSessions({ current: state.sessionMeta, sessions })
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

    case "SESSION_CREATED": {
      const created = action.payload;
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
      const updated = action.payload;
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

    case "SET_SESSION_META": {
      const { sessionId, meta } = action.payload;
      const nextMeta = { ...state.sessionMeta };
      const existing = nextMeta[sessionId] ?? {};
      nextMeta[sessionId] = { ...existing, ...meta };
      persistSessionMetaMap(nextMeta);
      const affectsSidebarPlacement =
        Object.hasOwn(meta, "sidebarSection") || Object.hasOwn(meta, "displayProjectDir");
      return {
        ...state,
        sessionMeta: nextMeta,
        sessions: affectsSidebarPlacement
          ? state.sessions.map((session) => (session.id === sessionId ? { ...session } : session))
          : state.sessions,
      };
    }

    default:
      return state;
  }
}
