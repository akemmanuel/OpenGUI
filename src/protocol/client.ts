import type { Agent, Command, QuestionAnswer } from "@opencode-ai/sdk/v2/client";
import type { AgentBackendId } from "@/agents";
import type {
  AgentBackendDescriptor,
  AgentBackendEvent,
  AgentBackendTarget,
} from "@/agents/backend";
import type { MessageEntry, Session } from "@/hooks/agent-state-types";
import type { QueueMode, QueuedPrompt } from "@/lib/session-drafts";
import type {
  BackendDetectionResult,
  ConnectionConfig,
  GitMergeResult,
  GitWorktree,
  InstallResult,
  ProvidersData,
  SelectedModel,
  WorktreeSetupDetection,
} from "@/types/electron";

export interface OpenGuiCapabilities {
  protocolVersion: number;
  server: {
    workspaces: boolean;
    projects: boolean;
    sessions: boolean;
    events: "websocket" | "sse" | false;
    auth: boolean;
    allowedRoots: boolean;
  };
  agentBackends: AgentBackendId[];
}

export interface OpenGuiWorkspace {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  defaultProjectId?: string;
  defaultAgentBackendId?: AgentBackendId;
  settings: Record<string, unknown>;
}

export interface CreateWorkspaceInput {
  name?: string;
  defaultAgentBackendId?: AgentBackendId;
  settings?: Record<string, unknown>;
}

export interface UpdateWorkspaceInput {
  name?: string;
  defaultProjectId?: string | null;
  defaultAgentBackendId?: AgentBackendId | null;
  settings?: Record<string, unknown>;
}

export interface OpenGuiProject {
  id: string;
  workspaceId: string;
  displayName: string;
  path: string;
  canonicalPath: string;
  allowedRootId?: string;
  git?: {
    currentBranch?: string;
    remoteUrl?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  displayName?: string;
  path: string;
  canonicalPath?: string;
  allowedRootId?: string;
}

export interface UpdateProjectInput {
  displayName?: string;
  path?: string;
  canonicalPath?: string;
  allowedRootId?: string | null;
}

export interface BackendResourceBundle {
  providersData: ProvidersData;
  agentsData: Agent[];
  commandsData: Command[];
}

export interface ProjectConnectResult {
  connectedBackendIds: AgentBackendId[];
  errors: Array<{ backendId: AgentBackendId; error: string }>;
}

export interface ProjectSessionsResult {
  backendId: AgentBackendId;
  sessions: Session[];
}

export interface SessionQueryProject {
  frontendProjectId: string;
  directory: string;
  workspaceId?: string;
  baseUrl?: string;
  authToken?: string;
}

export interface SessionQueryItem {
  frontendProjectId: string;
  directory: string;
  workspaceId?: string;
  harnessId: AgentBackendId;
  sessions: Session[];
}

export interface SessionQueryResult {
  items: SessionQueryItem[];
  errors?: Array<{
    frontendProjectId: string;
    directory: string;
    workspaceId?: string;
    harnessId?: AgentBackendId;
    error: string;
  }>;
}

export interface MessagePageResult {
  messages: MessageEntry[];
  nextCursor: string | null;
}

export interface OpenGuiQueueEntry extends QueuedPrompt {
  sessionId: string;
  canonicalSessionId?: string;
  order?: number;
}

export interface OpenGuiClient {
  capabilities(): Promise<OpenGuiCapabilities>;
  workspaces: {
    list(): Promise<OpenGuiWorkspace[]>;
    get(id: string): Promise<OpenGuiWorkspace | null>;
    create(input?: CreateWorkspaceInput): Promise<OpenGuiWorkspace>;
    update(id: string, input: UpdateWorkspaceInput): Promise<OpenGuiWorkspace | null>;
    delete(id: string): Promise<boolean>;
  };
  projects: {
    list(workspaceId: string): Promise<OpenGuiProject[]>;
    get(id: string): Promise<OpenGuiProject | null>;
    create(workspaceId: string, input: CreateProjectInput): Promise<OpenGuiProject>;
    update(id: string, input: UpdateProjectInput): Promise<OpenGuiProject | null>;
    delete(id: string): Promise<boolean>;
  };
  agentBackends: {
    list(): AgentBackendDescriptor[];
    get(backendId?: AgentBackendId): AgentBackendDescriptor | undefined;
    subscribe(listener: (event: AgentBackendEvent) => void): () => void;
    restart(): Promise<Record<AgentBackendId, { success: boolean; error?: string }>>;
    loadResources(input: {
      backendId: AgentBackendId;
      target?: AgentBackendTarget;
    }): Promise<BackendResourceBundle>;
    connectProject(input: {
      config: ConnectionConfig;
      backendIds?: AgentBackendId[];
    }): Promise<ProjectConnectResult>;
    disconnectProject(input: {
      target: AgentBackendTarget;
      backendIds?: AgentBackendId[];
    }): Promise<void>;
    listProjectSessions(input: {
      backendIds: AgentBackendId[];
      target: AgentBackendTarget;
      sync?: boolean;
    }): Promise<ProjectSessionsResult[]>;
    listProjectSessionStatuses(input: {
      backendIds: AgentBackendId[];
      target: AgentBackendTarget;
    }): Promise<Record<string, { type: string }>>;
  };
  sessions: {
    query(input: {
      projects: SessionQueryProject[];
      harnessIds: AgentBackendId[];
      sync?: boolean;
    }): Promise<SessionQueryResult>;
    create(input: {
      backendId: AgentBackendId;
      title?: string;
      target?: AgentBackendTarget;
    }): Promise<Session>;
    delete(input: {
      sessionId: string;
      backendId?: AgentBackendId;
      target?: AgentBackendTarget;
      confirmQueue?: boolean;
    }): Promise<boolean>;
    rename(input: {
      sessionId: string;
      title: string;
      backendId?: AgentBackendId;
      target?: AgentBackendTarget;
    }): Promise<Session>;
    getMessages(input: {
      sessionId: string;
      backendId?: AgentBackendId;
      options?: { limit?: number; before?: string } & AgentBackendTarget;
    }): Promise<MessagePageResult>;
    prompt(input: {
      sessionId: string;
      text: string;
      images?: string[];
      model?: SelectedModel;
      agent?: string;
      variant?: string;
      target?: AgentBackendTarget;
      backendId?: AgentBackendId;
    }): Promise<void>;
    abort(input: {
      sessionId: string;
      backendId?: AgentBackendId;
      target?: AgentBackendTarget;
    }): Promise<void>;
    respondPermission(input: {
      sessionId: string;
      permissionId: string;
      response: "once" | "always" | "reject";
      backendId?: AgentBackendId;
      target?: AgentBackendTarget;
    }): Promise<void>;
    replyQuestion(input: {
      requestId: string;
      answers: QuestionAnswer[];
      backendId?: AgentBackendId;
    }): Promise<void>;
    rejectQuestion(input: { requestId: string; backendId?: AgentBackendId }): Promise<void>;
    queue: {
      list(input: {
        sessionId: string;
        backendId?: AgentBackendId;
        target?: AgentBackendTarget;
      }): Promise<OpenGuiQueueEntry[]>;
      listProject(input: {
        backendId: AgentBackendId;
        target: AgentBackendTarget;
      }): Promise<Record<string, OpenGuiQueueEntry[]>>;
      enqueue(input: {
        sessionId: string;
        text: string;
        images?: string[];
        model?: SelectedModel;
        agent?: string;
        variant?: string;
        mode: QueueMode;
        backendId?: AgentBackendId;
        target?: AgentBackendTarget;
      }): Promise<OpenGuiQueueEntry[]>;
      remove(input: {
        sessionId: string;
        entryId: string;
        backendId?: AgentBackendId;
        target?: AgentBackendTarget;
      }): Promise<OpenGuiQueueEntry[]>;
      update(input: {
        sessionId: string;
        entryId: string;
        text?: string;
        images?: string[];
        model?: SelectedModel;
        agent?: string | null;
        variant?: string | null;
        mode?: QueueMode;
        backendId?: AgentBackendId;
        target?: AgentBackendTarget;
      }): Promise<OpenGuiQueueEntry[]>;
      reorder(input: {
        sessionId: string;
        entryId: string;
        index: number;
        backendId?: AgentBackendId;
        target?: AgentBackendTarget;
      }): Promise<OpenGuiQueueEntry[]>;
      dispatchNext(input: {
        sessionId: string;
        backendId?: AgentBackendId;
        target?: AgentBackendTarget;
      }): Promise<OpenGuiQueueEntry[]>;
    };
  };
  files: {
    find(input: {
      target: Pick<AgentBackendTarget, "directory">;
      query: string;
    }): Promise<string[]>;
  };
  git: {
    isRepo(directory: string): Promise<boolean>;
    listBranches(directory: string): Promise<string[]>;
    currentBranch(directory: string): Promise<string>;
    listWorktrees(directory: string): Promise<GitWorktree[]>;
    addWorktree(
      directory: string,
      worktreePath: string,
      branch: string,
      isNewBranch: boolean,
    ): Promise<{ path: string }>;
    removeWorktree(directory: string, worktreePath: string): Promise<void>;
    merge(directory: string, branch: string): Promise<GitMergeResult>;
    mergeAbort(directory: string): Promise<void>;
    getRemoteUrl(directory: string): Promise<string>;
  };
  worktree: {
    detectSetup(worktreePath: string): Promise<WorktreeSetupDetection>;
    runSetup(worktreePath: string, command: string): Promise<void>;
  };
  runtime: {
    getHomeDir(): Promise<string>;
    detectBackends(): Promise<BackendDetectionResult>;
    installBackend(backendId: AgentBackendId): Promise<InstallResult>;
  };
  desktop: {
    openDirectory(): Promise<string | null>;
  };
}
