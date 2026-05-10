import { createContext } from "react";
import type {
  Agent,
  Command,
  PermissionRequest,
  Provider,
  QuestionAnswer,
  QuestionRequest,
} from "@opencode-ai/sdk/v2/client";
import type { AgentBackendId } from "@/agents";
import type { VariantSelections } from "@/hooks/use-agent-variant-core";
import type {
  InternalAgentState,
  MessageEntry,
  QueueMode,
  TurnRun,
  QueuedPrompt,
  Session,
} from "@/hooks/agent-state-types";
import type {
  ProjectMeta,
  RecentProject,
  SessionColor,
  SessionMetaMap,
  WorktreeParentMap,
} from "@/hooks/agent-state-persistence";
import type {
  ConnectionConfig,
  ConnectionStatus,
  SelectedModel,
  Workspace,
} from "@/types/electron";

export interface SessionContextValue {
  sessions: Session[];
  activeSessionId: string | null;
  isBusy: boolean;
  isLoadingMessages: boolean;
  busySessionIds: Set<string>;
  queuedPrompts: Record<string, QueuedPrompt[]>;
  pendingPermissions: Record<string, PermissionRequest>;
  pendingQuestions: Record<string, QuestionRequest>;
  draftSessionDirectory: string | null;
  draftSessionBackendId: AgentBackendId | null;
  draftIsTemporary: boolean;
  temporarySessions: Set<string>;
  namingSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  sessionDrafts: Record<string, string>;
  sessionMeta: SessionMetaMap;
  recentProjects: RecentProject[];
}

export interface MessagesContextValue {
  messages: MessageEntry[];
  turnRuns: Record<string, TurnRun>;
  childSessions: InternalAgentState["childSessions"];
  messageHistoryHasMore: boolean;
  messageWindowHasNewer: boolean;
  isLoadingOlderMessages: boolean;
  isLoadingNewerMessages: boolean;
}

export interface ModelContextValue {
  providers: Provider[];
  providerDefaults: Record<string, string>;
  selectedModel: SelectedModel | null;
  agents: Agent[];
  selectedAgent: string | null;
  variantSelections: VariantSelections;
  commands: Command[];
  currentVariant: string | undefined;
}

export interface ConnectionContextValue {
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  activeWorkspaceId: string;
  workspaceStatuses: Record<
    string,
    {
      busy: boolean;
      needsAttention: boolean;
      error: boolean;
      connected: boolean;
    }
  >;
  connections: Record<string, ConnectionStatus>;
  workspaceDirectory: string | null;
  defaultChatDirectory: string | null;
  workspaceServerUrl: string | null;
  workspaceUsername: string | null;
  isLocalWorkspace: boolean;
  activeDirectory: string | null;
  bootState: InternalAgentState["bootState"];
  bootError: string | null;
  bootLogs: string | null;
  lastError: string | null;
  worktreeParents: WorktreeParentMap;
  projectMeta: Record<string, ProjectMeta>;
  pendingWorktreeCleanup: InternalAgentState["pendingWorktreeCleanup"];
}

export interface ActionsContextValue {
  addProject: (config: ConnectionConfig, options?: { suppressError?: boolean }) => Promise<void>;
  removeProject: (directory: string) => Promise<void>;
  disconnect: () => Promise<void>;
  selectSession: (id: string | null) => Promise<void>;
  loadOlderMessages: () => Promise<boolean>;
  loadNewerMessages: () => Promise<boolean>;
  createSession: (title?: string, directory?: string) => Promise<Session | null>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  sendPrompt: (text: string, images?: string[], mode?: QueueMode) => Promise<void>;
  findFiles: (directory: string | null, query: string) => Promise<string[]>;
  sendCommand: (command: string, args: string) => Promise<void>;
  summarizeSession: (model?: SelectedModel) => Promise<void>;
  abortSession: () => Promise<void>;
  respondPermission: (response: "once" | "always" | "reject") => Promise<void>;
  replyQuestion: (answers: QuestionAnswer[]) => Promise<void>;
  rejectQuestion: () => Promise<void>;
  setModel: (model: SelectedModel | null) => void;
  setAgent: (agent: string | null) => void;
  cycleVariant: () => void;
  revertVariant: () => void;
  clearError: () => void;
  refreshProviders: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  getQueuedPrompts: (sessionId: string) => QueuedPrompt[];
  removeFromQueue: (sessionId: string, promptId: string) => void;
  reorderQueue: (sessionId: string, fromIndex: number, toIndex: number) => void;
  updateQueuedPrompt: (sessionId: string, promptId: string, text: string) => void;
  sendQueuedNow: (sessionId: string, promptId: string) => Promise<void>;
  setSessionDraft: (key: string, text: string) => void;
  clearSessionDraft: (key: string) => void;
  openDirectory: () => Promise<string | null>;
  connectToProject: (
    directory: string,
    serverUrl?: string,
    username?: string,
    password?: string,
  ) => Promise<void>;
  startNewChat: () => Promise<void>;
  startDraftSession: (directory: string) => void;
  setDefaultChatDirectory: (directory: string | null) => void;
  setDraftDirectory: (directory: string) => void;
  setDraftBackend: (backendId: AgentBackendId) => void;
  setDraftTemporary: (temporary: boolean) => void;
  revertToMessage: (messageID: string) => Promise<void>;
  unrevert: () => Promise<void>;
  forkFromMessage: (messageID: string) => Promise<void>;
  setSessionColor: (sessionId: string, color: SessionColor) => void;
  setSessionTags: (sessionId: string, tags: string[]) => void;
  setSessionPinned: (sessionId: string, pinned: boolean) => void;
  moveSessionToProject: (sessionId: string, directory: string) => Promise<void>;
  setProjectPinned: (directory: string, pinned: boolean) => void;
  registerWorktree: (worktreeDir: string, parentDir: string, branch: string) => void;
  unregisterWorktree: (worktreeDir: string) => void;
  touchWorktree: (worktreeDir: string) => void;
  clearWorktreeCleanup: () => void;
  createWorkspace: (input: {
    name: string;
    serverUrl: string;
    username?: string;
    password?: string;
  }) => void;
  updateWorkspace: (
    workspaceId: string,
    input: Partial<Pick<Workspace, "name" | "serverUrl" | "username" | "password">>,
  ) => void;
  removeWorkspace: (workspaceId: string) => Promise<void>;
  switchWorkspace: (workspaceId: string) => void;
  reorderWorkspaces: (fromIndex: number, toIndex: number) => void;
  reorderProjects: (fromIndex: number, toIndex: number) => void;
  reorderVisibleProjects: (orderedDirectories: string[]) => void;
}

export const SessionContext = createContext<SessionContextValue | null>(null);
export const MessagesContext = createContext<MessagesContextValue | null>(null);
export const ModelContext = createContext<ModelContextValue | null>(null);
export const ConnectionContext = createContext<ConnectionContextValue | null>(null);
export const ActionsContext = createContext<ActionsContextValue | null>(null);
