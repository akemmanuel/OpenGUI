import type {
  Agent,
  Command,
  HarnessSession as BaseSession,
  Message,
  Part,
  PermissionRequest,
  Provider,
  QuestionRequest,
} from "@/protocol/harness-types";
import type { HarnessId } from "@/agents";
import type {
  ProjectMetaMap,
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
  _harnessId?: HarnessId;
  /** Legacy field persisted by versions before the Harness migration. */
  _backendId?: HarnessId;
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

export interface WorkspaceResourceState {
  /** Available providers and their models for this workspace. */
  providers: Provider[];
  /** Default model mappings from this workspace's server config. */
  providerDefaults: { [key: string]: string };
  /** Available agents from this workspace's server. */
  agents: Agent[];
  /** Available slash commands from this workspace's server. */
  commands: Command[];
  /** Per-model variant selections for this workspace. */
  variantSelections: VariantSelections;
  /** Backend that produced this resource catalog. */
  loadedBackendId: HarnessId | null;
  /** Workspace-scoped project key that produced this resource catalog. */
  loadedProjectKey: string | null;
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
  /** Whether older messages exist before the loaded active-session window */
  messageHistoryHasMore: boolean;
  /** Opaque cursor for fetching the next page of older messages */
  messageHistoryCursor: string | null;
  /** Whether messages are being fetched for a newly selected session */
  isLoadingMessages: boolean;
  /** Whether older messages are currently being prepended to the active window */
  isLoadingOlderMessages: boolean;
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
  /** Resource catalogs keyed by workspace ID. */
  workspaceResources: Record<string, WorkspaceResourceState>;
  /** Available providers and their models for the active workspace */
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
  /** Default chat directory for Chats section Sessions. */
  defaultChatDirectory: string | null;
  /** Directory selected for the next session before a session exists. */
  activeTargetDirectory: string | null;
  /** Backend selected for the next session before a session exists. */
  activeTargetBackendId: HarnessId | null;
  /** Set of session IDs that are waiting for generated title */
  namingSessionIds: Set<string>;
  /** Set of session IDs that have unread content (finished generating while not active) */
  unreadSessionIds: Set<string>;
  /** Local-only unsent textarea text keyed by session or pending target directory. */
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

export type HarnessState = InternalAgentState;
export type { QueueMode, QueuedPrompt } from "@/lib/session-drafts";
