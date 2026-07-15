import type {
  Agent,
  Command,
  AgentSession as BaseSession,
  Message,
  Part,
  PermissionRequest,
  Provider,
  QuestionRequest,
} from "@/protocol/agent-types";
import type { ProjectMetaMap, SessionMetaMap } from "@/hooks/agent-state-persistence";
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
 * `_projectDir` is set by the Host layer to the registered project directory
 * that returned the session, so the UI can group sessions reliably without
 * brittle string equality on `session.directory`. `_workspaceId` tags which
 * workspace owns that connection, so identical paths stay isolated.
 */
export type Session = BaseSession & {
  _projectDir?: string;
  _workspaceId?: string;
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
  /** Whether a prompt response is in-flight */
  isBusy: boolean;
  /** Pending permission requests keyed by sessionID */
  pendingPermissions: Record<string, PermissionRequest>;
  /** Pending questions keyed by sessionID */
  pendingQuestions: Record<string, QuestionRequest>;
  /** Last error surfaced to UI */
  lastError: string | null;
  /** Last error per session, shown next to active chat input */
  sessionErrors: Record<string, string>;
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
  /** Session ids retained briefly in the sidebar while Host state catches up. */
  liveSessionRetainUntil: Record<string, number>;
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
  /** Explicit frontend request/turn runs, keyed by turn ID. */
  turnRuns: Record<string, TurnRun>;
  /** Currently running turn ID per session. */
  activeTurnRunBySession: Record<string, string>;
  /** Session IDs that have an "after-part" queued prompt waiting for the current part to finish */
  afterPartPending: Set<string>;
  /** Session IDs where an after-part trigger just fired (effect picks this up to abort + dispatch) */
  _afterPartTriggered: Set<string>;
  /** Session IDs that were optimistically deleted - prevents backend events from re-adding them */
  _deletedSessionIds: Set<string>;
}

export type AgentState = InternalAgentState;
export type { QueueMode, QueuedPrompt } from "@/lib/session-drafts";
