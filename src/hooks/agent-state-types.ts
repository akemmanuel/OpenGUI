import type {
  Agent,
  Command,
  Message,
  Part,
  PermissionRequest,
  Provider,
  QuestionRequest,
  Session as BaseSession,
} from "@opencode-ai/sdk/v2/client";
import type { AgentBackendId } from "@/agents";
import type {
  ProjectMetaMap,
  RecentProject,
  SessionMetaMap,
  WorktreeParentMap,
} from "@/hooks/agent-state-persistence";
import type { VariantSelections } from "@/hooks/use-agent-variant-core";
import type { QueuedPrompt, SessionDraftMap } from "@/lib/session-drafts";
import type { ConnectionStatus, SelectedModel, Workspace } from "@/types/electron";

/**
 * Extended session type that includes project directory session was
 * loaded from. Backend may already scope session listings per
 * project, but `directory` field
 * stored *on* each session may differ slightly from the connection directory
 * (trailing slashes, symlink resolution, git-toplevel normalization, etc.).
 *
 * `_projectDir` is set by the bridge/IPC layer to the *connection* directory
 * that returned the session, so the UI can group sessions reliably without
 * brittle string equality on `session.directory`. `_workspaceId` tags which
 * workspace owns that connection, so identical paths stay isolated.
 */
export type Session = BaseSession & {
  _projectDir?: string;
  _workspaceId?: string;
  _backendId?: AgentBackendId;
  _rawId?: string;
};

export interface MessageEntry {
  info: Message;
  parts: Part[];
}

export interface TurnRun {
  id: string;
  sessionID: string;
  startedAt: number;
  completedAt?: number;
  status: "running" | "completed" | "error" | "aborted";
  assistantMessageID?: string;
  providerID?: string;
  modelID?: string;
  thinkingLevel?: string;
}

export interface InternalAgentState {
  /** Configured workspaces. */
  workspaces: Workspace[];
  /** Currently selected workspace tab. */
  activeWorkspaceId: string;
  /** Maps connected project directories to their workspace. */
  projectWorkspaceMap: Record<string, Set<string>>;
  /** Per-project connection statuses keyed by directory */
  connections: Record<string, ConnectionStatus>;
  /** All sessions from all connected projects */
  sessions: Session[];
  /** Currently selected session ID */
  activeSessionId: string | null;
  /** Messages for the active session */
  messages: MessageEntry[];
  /** Newer active-session messages trimmed out of the current window */
  messageForwardBuffer: MessageEntry[];
  /** Whether older messages exist before the loaded active-session window */
  messageHistoryHasMore: boolean;
  /** Opaque cursor for fetching the next page of older messages */
  messageHistoryCursor: string | null;
  /** Whether newer messages exist after the loaded active-session window */
  messageWindowHasNewer: boolean;
  /** Whether messages are being fetched for a newly selected session */
  isLoadingMessages: boolean;
  /** Whether older messages are currently being prepended to the active window */
  isLoadingOlderMessages: boolean;
  /** Whether newer messages are currently being restored into the active window */
  isLoadingNewerMessages: boolean;
  /** Whether a prompt response is in-flight */
  isBusy: boolean;
  /** Pending permission requests keyed by sessionID */
  pendingPermissions: Record<string, PermissionRequest>;
  /** Pending questions keyed by sessionID */
  pendingQuestions: Record<string, QuestionRequest>;
  /** Last error surfaced to UI */
  lastError: string | null;
  /** App startup status for local server bootstrap */
  bootState: "idle" | "checking-server" | "starting-server" | "ready" | "error";
  /** Startup error shown only when bootstrap fails */
  bootError: string | null;
  /** Server process logs captured during a failed startup */
  bootLogs: string | null;
  /** Available providers and their models */
  providers: Provider[];
  /** Default model mappings from server config */
  providerDefaults: { [key: string]: string };
  /** Currently selected model for prompts (null until resolved/selected) */
  selectedModel: SelectedModel | null;
  /** Set of session IDs that are currently busy (generating) */
  busySessionIds: Set<string>;
  /** Available agents from the server */
  agents: Agent[];
  /** Currently selected agent name (null = server default) */
  selectedAgent: string | null;
  /** Per-model variant selections */
  variantSelections: VariantSelections;
  /** Available slash commands from the server */
  commands: Command[];
  /** Per-session queued prompts (sent automatically when session becomes idle) */
  queuedPrompts: Record<string, QueuedPrompt[]>;
  /** Recently opened projects */
  recentProjects: RecentProject[];
  /** User home directory used as fallback for chat-first mode. */
  homeDirectory: string | null;
  /** Default working directory for chats started from the global chat entry. */
  defaultChatDirectory: string | null;
  /** Directory for a draft (not-yet-created) session. Null when no draft is active. */
  draftSessionDirectory: string | null;
  /** Backend chosen for draft/new session. */
  draftSessionBackendId: AgentBackendId | null;
  /** Whether the current draft should create a temporary (non-persisted) session */
  draftIsTemporary: boolean;
  /** Set of session IDs marked as temporary (auto-deleted on navigate away) */
  temporarySessions: Set<string>;
  /** Set of session IDs that are waiting for generated title */
  namingSessionIds: Set<string>;
  /** Set of session IDs that have unread content (finished generating while not active) */
  unreadSessionIds: Set<string>;
  /** Local-only unsent textarea drafts keyed by session or draft directory. */
  sessionDrafts: SessionDraftMap;
  /** Local-only session metadata (colors, tags, pins) keyed by session ID */
  sessionMeta: SessionMetaMap;
  /** Local-only project metadata (pins) keyed by workspace+directory */
  projectMeta: ProjectMetaMap;
  /** Maps worktree directory -> metadata incl. parent project directory (local-only) */
  worktreeParents: WorktreeParentMap;
  /** Pending worktree cleanup prompt (shown after last session in a worktree is deleted) */
  pendingWorktreeCleanup: {
    worktreeDir: string;
    parentDir: string;
  } | null;
  /** Explicit frontend request/turn runs, keyed by turn ID. */
  turnRuns: Record<string, TurnRun>;
  /** Currently running turn ID per session. */
  activeTurnRunBySession: Record<string, string>;
  /** Messages/parts for child (subagent) sessions, keyed by child sessionID */
  childSessions: Record<string, Record<string, { info: Message; parts: Record<string, Part> }>>;
  /** Set of child session IDs we're actively tracking (from running Task tool parts) */
  trackedChildSessionIds: Set<string>;
  /** Snapshot events queued while messages are loading for the active session */
  _pendingSnapshots: Array<
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
  >;
  /** Buffered message snapshots for non-active sessions (keyed by sessionID) */
  _sessionBuffers: Record<
    string,
    {
      messages: Record<string, { info: Message; parts: Record<string, Part> }>;
      hasMore: boolean;
      cursor: string | null;
      /** Whether this buffer was created from a full session snapshot (true)
       *  or built incrementally from backend events only (false/undefined).
       *  Incomplete buffers must trigger a fetchMessagePage when restored. */
      complete?: boolean;
    }
  >;
  /** Session IDs that have an "after-part" queued prompt waiting for the current part to finish */
  afterPartPending: Set<string>;
  /** Session IDs where an after-part trigger just fired (effect picks this up to abort + dispatch) */
  _afterPartTriggered: Set<string>;
  /** Session IDs that were optimistically deleted - prevents backend events from re-adding them */
  _deletedSessionIds: Set<string>;
}

export type AgentBackendState = InternalAgentState;
export type OpenCodeState = InternalAgentState;
export type { QueueMode, QueuedPrompt } from "@/lib/session-drafts";
