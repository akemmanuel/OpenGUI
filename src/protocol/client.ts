import type { Agent, Command, QuestionAnswer } from "@opencode-ai/sdk/v2/client";
import type { HarnessId } from "@/agents";
import type { HarnessDescriptor, HarnessEvent, HarnessTarget } from "@/agents/backend";
import type { MessageEntry, Session } from "@/hooks/agent-state-types";
import type { QueueMode, QueuedPrompt } from "@/lib/session-drafts";
import type {
  ConnectionConfig,
  GitMergeResult,
  GitWorktree,
  HarnessInventory,
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
  harnesses: HarnessId[];
}

export interface FrontendWorkspaceRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  defaultProjectId?: string;
  defaultHarnessId?: HarnessId;
  settings: Record<string, unknown>;
}

export interface CreateFrontendWorkspaceInput {
  name?: string;
  defaultHarnessId?: HarnessId;
  settings?: Record<string, unknown>;
}

export interface UpdateFrontendWorkspaceInput {
  name?: string;
  defaultProjectId?: string | null;
  defaultHarnessId?: HarnessId | null;
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

export interface HarnessResourceBundle {
  providersData: ProvidersData;
  agentsData: Agent[];
  commandsData: Command[];
}

export interface ProjectConnectResult {
  connectedHarnessIds: HarnessId[];
  errors: Array<{ harnessId: HarnessId; error: string }>;
}

export interface HarnessProjectSessionsResult {
  harnessId: HarnessId;
  sessions: Session[];
}

export interface SessionQueryProject {
  directory: string;
  workspaceId?: string;
  baseUrl?: string;
  authToken?: string;
}

export interface SessionQueryItem {
  directory: string;
  workspaceId?: string;
  harnessId: HarnessId;
  sessions: Session[];
}

export interface SessionQueryResult {
  items: SessionQueryItem[];
  errors?: Array<{
    directory: string;
    workspaceId?: string;
    harnessId?: HarnessId;
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
  harnessId: HarnessId;
  projectDirectory: string;
  harnessSessionId: string;
  order?: number;
}

export type QueueHarnessTarget = HarnessTarget & { directory: string };

export interface QueueScopeInput {
  harnessId: HarnessId;
  target: QueueHarnessTarget;
}

export interface OpenGuiClient {
  capabilities(): Promise<OpenGuiCapabilities>;
  projects: {
    list(workspaceId: string): Promise<OpenGuiProject[]>;
    get(id: string): Promise<OpenGuiProject | null>;
    create(workspaceId: string, input: CreateProjectInput): Promise<OpenGuiProject>;
    update(id: string, input: UpdateProjectInput): Promise<OpenGuiProject | null>;
    delete(id: string): Promise<boolean>;
  };
  harnesses: {
    list(): HarnessDescriptor[];
    get(harnessId?: HarnessId): HarnessDescriptor | undefined;
    subscribe(listener: (event: HarnessEvent) => void): () => void;
    restart(): Promise<Record<HarnessId, { success: boolean; error?: string }>>;
    loadResources(input: {
      harnessId: HarnessId;
      target?: HarnessTarget;
    }): Promise<HarnessResourceBundle>;
    connectProject(input: {
      config: ConnectionConfig;
      harnessIds?: HarnessId[];
    }): Promise<ProjectConnectResult>;
    disconnectProject(input: { target: HarnessTarget; harnessIds?: HarnessId[] }): Promise<void>;
    listProjectSessions(input: {
      harnessIds: HarnessId[];
      target: HarnessTarget;
      sync?: boolean;
    }): Promise<HarnessProjectSessionsResult[]>;
    listProjectSessionStatuses(input: {
      harnessIds: HarnessId[];
      target: HarnessTarget;
    }): Promise<Record<string, { type: string }>>;
  };
  sessions: {
    query(input: {
      projects: SessionQueryProject[];
      harnessIds: HarnessId[];
      sync?: boolean;
    }): Promise<SessionQueryResult>;
    create(input: {
      harnessId: HarnessId;
      title?: string;
      target?: HarnessTarget;
    }): Promise<Session>;
    delete(input: {
      sessionId: string;
      harnessId?: HarnessId;
      target?: HarnessTarget;
      confirmQueue?: boolean;
    }): Promise<boolean>;
    rename(input: {
      sessionId: string;
      title: string;
      harnessId?: HarnessId;
      target?: HarnessTarget;
    }): Promise<Session>;
    getMessages(input: {
      sessionId: string;
      harnessId?: HarnessId;
      options?: { limit?: number; before?: string } & HarnessTarget;
    }): Promise<MessagePageResult>;
    prompt(input: {
      sessionId: string;
      text: string;
      model?: SelectedModel;
      agent?: string;
      variant?: string;
      mode?: QueueMode;
      target?: HarnessTarget;
      harnessId?: HarnessId;
    }): Promise<void>;
    abort(input: {
      sessionId: string;
      harnessId?: HarnessId;
      target?: HarnessTarget;
    }): Promise<void>;
    respondPermission(input: {
      sessionId: string;
      permissionId: string;
      response: "once" | "always" | "reject";
      harnessId?: HarnessId;
      target?: HarnessTarget;
    }): Promise<void>;
    replyQuestion(input: {
      sessionId?: string;
      requestId: string;
      answers: QuestionAnswer[];
      harnessId?: HarnessId;
      target?: HarnessTarget;
    }): Promise<void>;
    rejectQuestion(input: {
      sessionId?: string;
      requestId: string;
      harnessId?: HarnessId;
      target?: HarnessTarget;
    }): Promise<void>;
    queue: {
      list(
        input: QueueScopeInput & {
          sessionId: string;
        },
      ): Promise<OpenGuiQueueEntry[]>;
      listProject(input: {
        harnessId: HarnessId;
        target: QueueHarnessTarget;
      }): Promise<Record<string, OpenGuiQueueEntry[]>>;
      enqueue(
        input: QueueScopeInput & {
          sessionId: string;
          text: string;
          model?: SelectedModel;
          agent?: string;
          variant?: string;
          mode: QueueMode;
          insertAt?: "front" | "back";
        },
      ): Promise<OpenGuiQueueEntry[]>;
      remove(
        input: QueueScopeInput & {
          sessionId: string;
          entryId: string;
        },
      ): Promise<OpenGuiQueueEntry[]>;
      update(
        input: QueueScopeInput & {
          sessionId: string;
          entryId: string;
          text?: string;
          model?: SelectedModel;
          agent?: string | null;
          variant?: string | null;
          mode?: QueueMode;
        },
      ): Promise<OpenGuiQueueEntry[]>;
      reorder(
        input: QueueScopeInput & {
          sessionId: string;
          entryId: string;
          index: number;
        },
      ): Promise<OpenGuiQueueEntry[]>;
      sendNow(
        input: QueueScopeInput & {
          sessionId: string;
          entryId: string;
        },
      ): Promise<OpenGuiQueueEntry[]>;
    };
  };
  files: {
    find(input: { target: HarnessTarget; query: string }): Promise<string[]>;
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
    getHarnessInventories(): Promise<HarnessInventory[]>;
  };
  desktop: {
    openDirectory(): Promise<string | null>;
  };
}
