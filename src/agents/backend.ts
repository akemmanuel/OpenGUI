import type {
  Message,
  McpLocalConfig,
  McpRemoteConfig,
  McpStatus,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  Config as OpenCodeConfig,
} from "@opencode-ai/sdk/v2/client";
import type {
  AllProvidersData,
  ConnectionStatus,
  InstalledSkillInfo,
  MarketplaceAuditResponse,
  MarketplaceCuratedResponse,
  MarketplaceDetailResponse,
  MarketplaceListResponse,
  MarketplaceSearchResponse,
  ProviderAuth,
  ProviderAuthMethod,
  ProviderOAuthAuthorization,
  SelectedModel,
} from "@/types/electron";

export interface AgentBackendTarget {
  directory?: string;
  workspaceId?: string;
  baseUrl?: string;
  authToken?: string;
}

export interface AgentBackendCapabilities {
  sessions: boolean;
  streaming: boolean;
  messagePaging: boolean;
  models: boolean;
  agents: boolean;
  commands: boolean;
  compact: boolean;
  fork: boolean;
  revert: boolean;
  permissions: boolean;
  questions: boolean;
  providerAuth: boolean;
  mcp: boolean;
  skills: boolean;
  config: boolean;
  localServer: boolean;
}

interface AgentBackendWorkspaceProfile {
  kind: "remote-server" | "local-cli";
  fields: {
    serverUrl: boolean;
    username: boolean;
    password: boolean;
    directory: boolean;
  };
}

interface AgentSessionStatus {
  type: string;
}

export type AgentBackendEvent =
  | {
      type: "connection.status";
      directory: string;
      workspaceId?: string;
      status: ConnectionStatus;
    }
  | {
      type: "session.created" | "session.updated";
      directory: string;
      workspaceId?: string;
      session: Session;
    }
  | {
      type: "session.replaced";
      directory: string;
      workspaceId?: string;
      oldId: string;
      newId: string;
      session: Session;
    }
  | {
      type: "session.deleted";
      directory: string;
      workspaceId?: string;
      sessionId: string;
    }
  | { type: "message.updated"; message: Message }
  | {
      type: "message.replaced";
      sessionID: string;
      oldId: string;
      message: Message;
      parts: Part[];
    }
  | { type: "message.part.updated"; part: Part }
  | {
      type: "message.part.delta";
      sessionID: string;
      messageID: string;
      partID: string;
      field: string;
      delta: string;
    }
  | {
      type: "message.part.removed";
      sessionID: string;
      messageID: string;
      partID: string;
    }
  | { type: "message.removed"; sessionID: string; messageID: string }
  | { type: "session.status"; sessionID: string; status: AgentSessionStatus }
  | { type: "permission.requested"; request: PermissionRequest }
  | { type: "permission.cleared"; sessionID: string }
  | { type: "question.requested"; request: QuestionRequest }
  | { type: "question.cleared"; sessionID: string }
  | { type: "session.error"; error: string; sessionID?: string };

interface AgentRuntimeBackend {
  createSession(input?: {
    title?: string;
    directory?: string;
    workspaceId?: string;
    baseUrl?: string;
  }): Promise<Session>;
  startSession?(input: {
    text: string;
    model?: SelectedModel;
    agent?: string;
    variant?: string;
    title?: string;
    directory?: string;
    workspaceId?: string;
    baseUrl?: string;
  }): Promise<Session>;
  deleteSession(sessionId: string): Promise<boolean>;
  renameSession(sessionId: string, title: string): Promise<Session>;
  compactSession(
    sessionId: string,
    model?: SelectedModel,
    target?: AgentBackendTarget,
  ): Promise<void>;
  forkSession(sessionId: string, messageID?: string): Promise<Session>;
  revertSession(sessionId: string, messageID: string, partID?: string): Promise<Session>;
  unrevertSession(sessionId: string): Promise<Session>;
  sendCommand(input: {
    sessionId: string;
    command: string;
    args: string;
    model?: SelectedModel;
    agent?: string;
    variant?: string;
    directory?: string;
    workspaceId?: string;
  }): Promise<void>;
}

interface AgentPlatformBackend {
  server?: {
    start(): Promise<{ alreadyRunning?: boolean }>;
    stop(): Promise<{ alreadyStopped?: boolean; pid?: number }>;
    status(): Promise<{ running: boolean }>;
  };
  providers?: {
    listAll(target?: AgentBackendTarget): Promise<AllProvidersData>;
    getAuthMethods(target?: AgentBackendTarget): Promise<Record<string, ProviderAuthMethod[]>>;
    connect(target: AgentBackendTarget, providerID: string, auth: ProviderAuth): Promise<void>;
    disconnect(target: AgentBackendTarget, providerID: string): Promise<void>;
    oauthAuthorize(
      target: AgentBackendTarget,
      providerID: string,
      method?: number,
    ): Promise<ProviderOAuthAuthorization>;
    oauthCallback(
      target: AgentBackendTarget,
      providerID: string,
      method?: number,
      code?: string,
    ): Promise<boolean>;
    dispose(target?: AgentBackendTarget): Promise<boolean>;
  };
  mcp?: {
    status(target?: AgentBackendTarget): Promise<Record<string, McpStatus>>;
    add(
      target: AgentBackendTarget,
      name: string,
      config: McpLocalConfig | McpRemoteConfig,
    ): Promise<Record<string, McpStatus>>;
    connect(target: AgentBackendTarget, name: string): Promise<void>;
    disconnect(target: AgentBackendTarget, name: string): Promise<void>;
  };
  skills?: {
    list(target?: AgentBackendTarget): Promise<InstalledSkillInfo[]>;

    marketplace: {
      list(
        view?: string,
        page?: number,
        perPage?: number,
        apiKey?: string,
      ): Promise<MarketplaceListResponse>;
      search(query: string, limit?: number, apiKey?: string): Promise<MarketplaceSearchResponse>;
      detail(source: string, slug: string, apiKey?: string): Promise<MarketplaceDetailResponse>;
      audit(source: string, slug: string, apiKey?: string): Promise<MarketplaceAuditResponse>;
      curated(apiKey?: string): Promise<MarketplaceCuratedResponse>;
    };

    install(
      source: string,
      directory?: string,
      globalScope?: boolean,
    ): Promise<{ exitCode?: number }>;

    remove(
      skillName: string,
      directory?: string,
      globalScope?: boolean,
    ): Promise<{ exitCode?: number }>;

    update(
      skillName?: string,
      directory?: string,
      globalScope?: boolean,
    ): Promise<{ exitCode?: number }>;

    listInstalled(directory?: string): Promise<InstalledSkillInfo[]>;

    checkCli(): Promise<{ available: boolean; command: string | null }>;
  };
  config?: {
    get(target?: AgentBackendTarget): Promise<OpenCodeConfig>;
    update(target: AgentBackendTarget, config: Partial<OpenCodeConfig>): Promise<OpenCodeConfig>;
  };
}

export interface AgentBackendDescriptor {
  id: string;
  label: string;
  workspace: AgentBackendWorkspaceProfile;
  capabilities: AgentBackendCapabilities;
  runtime: AgentRuntimeBackend;
  platform?: AgentPlatformBackend;
}
