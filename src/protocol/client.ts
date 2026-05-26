import type { Agent, Command, QuestionAnswer } from "@opencode-ai/sdk/v2/client";
import type { AgentBackendId } from "@/agents";
import type {
  AgentBackendDescriptor,
  AgentBackendEvent,
  AgentBackendTarget,
} from "@/agents/backend";
import type { MessageEntry, Session } from "@/hooks/agent-state-types";
import type { ConnectionConfig, ProvidersData, SelectedModel } from "@/types/electron";

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

export interface MessagePageResult {
  messages: MessageEntry[];
  nextCursor: string | null;
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
    }): Promise<ProjectSessionsResult[]>;
    listProjectSessionStatuses(input: {
      backendIds: AgentBackendId[];
      target: AgentBackendTarget;
    }): Promise<Record<string, { type: string }>>;
  };
  sessions: {
    create(input: {
      backendId: AgentBackendId;
      title?: string;
      target?: AgentBackendTarget;
    }): Promise<Session>;
    delete(input: { sessionId: string; backendId?: AgentBackendId }): Promise<boolean>;
    rename(input: {
      sessionId: string;
      title: string;
      backendId?: AgentBackendId;
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
    abort(input: { sessionId: string; backendId?: AgentBackendId }): Promise<void>;
    respondPermission(input: {
      sessionId: string;
      permissionId: string;
      response: "once" | "always" | "reject";
      backendId?: AgentBackendId;
    }): Promise<void>;
    replyQuestion(input: {
      requestId: string;
      answers: QuestionAnswer[];
      backendId?: AgentBackendId;
    }): Promise<void>;
    rejectQuestion(input: { requestId: string; backendId?: AgentBackendId }): Promise<void>;
  };
  files: {
    find(input: {
      target: Pick<AgentBackendTarget, "directory">;
      query: string;
    }): Promise<string[]>;
  };
  desktop: {
    openDirectory(): Promise<string | null>;
  };
}
