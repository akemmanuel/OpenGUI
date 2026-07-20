import { createContext } from "react";
import type {
  Agent,
  Command,
  PermissionRequest,
  Provider,
  QuestionAnswer,
  QuestionRequest,
} from "@/protocol/agent-types";
import type { VariantSelections } from "@/hooks/use-agent-variant-core";
import type { ReasoningEffort } from "@/protocol/host-types";
import type {
  TransportAgentState,
  QueueMode,
  QueuedPrompt,
  Session,
  WorkspaceResourceState,
} from "@/hooks/agent-state-types";
import type { ProjectMetaMap, SessionColor, SessionMetaMap } from "@/lib/persistence";
import type { ConnectionStatus } from "@/types/connection";
import type { SelectedModel } from "@opengui/protocol";
import type { Workspace } from "@/types/workspace";

export interface SessionContextValue {
  sessions: Session[];
  activeSessionId: string | null;
  isBusy: boolean;
  busySessionIds: Set<string>;
  queuedPrompts: Record<string, QueuedPrompt[]>;
  pendingPermissions: Record<string, PermissionRequest>;
  pendingQuestions: Record<string, QuestionRequest>;
  activeTargetDirectory: string | null;
  namingSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  sessionDrafts: Record<string, string>;
  sessionMeta: SessionMetaMap;
  sessionErrors: Record<string, string>;
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
  reasoningEffort?: ReasoningEffort;
}

export interface WorkspaceContextValue {
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  activeWorkspaceId: string;
  supportsMultipleWorkspaces: boolean;
  /** False when no workspace is configured; project connect actions must be blocked. */
  canManageProjects: boolean;
  workspaceStatuses: Record<
    string,
    {
      busy: boolean;
      needsAttention: boolean;
      error: boolean;
      connected: boolean;
    }
  >;
  workspaceResources: Record<string, WorkspaceResourceState>;
  connections: Record<string, ConnectionStatus>;
  workspaceDirectory: string | null;
  defaultChatDirectory: string | null;
  activeDirectory: string | null;
  projectMeta: ProjectMetaMap;
  workspaceServerUrl: string | null;
  isLocalWorkspace: boolean;
  /** Desktop Shell + Local Workspace: native OS directory picker. */
  supportsNativeDirectoryPicker: boolean;
  /** Base URL for attachment/image paths; null for Electron local backend. */
  attachmentBaseUrl: string | null;
  bootState: TransportAgentState["bootState"];
  bootError: string | null;
  bootLogs: string | null;
  lastError: string | null;
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
  setPromptBoxSelection: (input: { model: SelectedModel }) => void;
  setAgent: (agent: string | null) => void;
  cycleVariant: () => void;
  revertVariant: () => void;
  setReasoningEffort?: (effort: ReasoningEffort) => Promise<void>;
  clearError: () => void;
  refreshProviders: () => Promise<void>;
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
    options?: { resetSelection?: boolean; newChat?: boolean },
  ) => void;
  setDefaultChatDirectory: (directory: string | null) => void;
  setActiveTargetDirectory: (directory: string) => void;
  revertToMessage: (messageID: string) => Promise<void>;
  unrevert: () => Promise<void>;
  forkFromMessage: (messageID: string) => Promise<void>;
  setSessionColor: (sessionId: string, color: SessionColor) => void;
  setSessionTags: (sessionId: string, tags: string[]) => void;
  setSessionPinned: (sessionId: string, pinned: boolean) => void;
  moveSessionToProject: (sessionId: string, directory: string) => Promise<void>;
  removeSessionFromProject: (sessionId: string) => Promise<void>;
  setProjectPinned: (directory: string, pinned: boolean) => void;
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
export const ModelContext = createContext<ModelContextValue | null>(null);
export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
export const ActionsContext = createContext<ActionsContextValue | null>(null);
