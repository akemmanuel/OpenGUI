import { createContext } from "react";
import type {
  Agent,
  Command,
  PermissionRequest,
  Provider,
  QuestionAnswer,
  QuestionRequest,
} from "@/protocol/harness-types";
import type { HarnessId } from "@/agents";
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
  SessionColor,
  SessionMetaMap,
  WorktreeParentMap,
} from "@/hooks/agent-state-persistence";
import type { ConnectionStatus, SelectedModel, Workspace } from "@/types/electron";

export interface SessionContextValue {
  sessions: Session[];
  activeSessionId: string | null;
  isBusy: boolean;
  isLoadingMessages: boolean;
  busySessionIds: Set<string>;
  queuedPrompts: Record<string, QueuedPrompt[]>;
  pendingPermissions: Record<string, PermissionRequest>;
  pendingQuestions: Record<string, QuestionRequest>;
  activeTargetDirectory: string | null;
  activeTargetBackendId: HarnessId | null;
  namingSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  sessionDrafts: Record<string, string>;
  sessionMeta: SessionMetaMap;
  sessionErrors: Record<string, string>;
}

export interface MessagesContextValue {
  messages: MessageEntry[];
  turnRuns: Record<string, TurnRun>;
  childSessions: InternalAgentState["childSessions"];
  messageHistoryHasMore: boolean;
  isLoadingOlderMessages: boolean;
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
  supportsMultipleWorkspaces: boolean;
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
  removeProject: (directory: string) => Promise<void>;
  selectSession: (id: string | null) => Promise<void>;
  loadOlderMessages: () => Promise<boolean>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  sendPrompt: (text: string, mode?: QueueMode) => Promise<void>;
  findFiles: (
    target: { directory?: string; workspaceId?: string; baseUrl?: string } | null,
    query: string,
  ) => Promise<string[]>;
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
  restartHarnesses: () => Promise<void>;
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
  setActiveTarget: (
    directory: string,
    harnessId?: HarnessId | null,
    options?: { resetSelection?: boolean; newChat?: boolean },
  ) => void;
  setDefaultChatDirectory: (directory: string | null) => void;
  setActiveTargetDirectory: (directory: string) => void;
  setActiveTargetBackend: (harnessId: HarnessId) => void;
  revertToMessage: (messageID: string) => Promise<void>;
  unrevert: () => Promise<void>;
  forkFromMessage: (messageID: string) => Promise<void>;
  setSessionColor: (sessionId: string, color: SessionColor) => void;
  setSessionTags: (sessionId: string, tags: string[]) => void;
  setSessionPinned: (sessionId: string, pinned: boolean) => void;
  moveSessionToProject: (sessionId: string, directory: string) => Promise<void>;
  removeSessionFromProject: (sessionId: string) => Promise<void>;
  setProjectPinned: (directory: string, pinned: boolean) => void;
  registerWorktree: (worktreeDir: string, parentDir: string, branch: string) => void;
  unregisterWorktree: (worktreeDir: string) => void;
  clearWorktreeCleanup: () => void;
  createWorkspace: (input: { name: string; serverUrl: string; authToken?: string }) => void;
  updateWorkspace: (
    workspaceId: string,
    input: Partial<Pick<Workspace, "name" | "serverUrl" | "authToken">>,
  ) => void;
  removeWorkspace: (workspaceId: string) => Promise<void>;
  switchWorkspace: (workspaceId: string) => void;
  reorderWorkspaces: (fromIndex: number, toIndex: number) => void;
  reorderVisibleProjects: (orderedDirectories: string[]) => void;
}

export const SessionContext = createContext<SessionContextValue | null>(null);
export const MessagesContext = createContext<MessagesContextValue | null>(null);
export const ModelContext = createContext<ModelContextValue | null>(null);
export const ConnectionContext = createContext<ConnectionContextValue | null>(null);
export const ActionsContext = createContext<ActionsContextValue | null>(null);
