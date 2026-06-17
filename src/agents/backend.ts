import type {
  HarnessConfig,
  HarnessSession as Session,
  McpLocalConfig,
  McpRemoteConfig,
  McpStatus,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
} from "@/protocol/harness-types";
import type {
  AllProvidersData,
  ConnectionStatus,
  ProviderAuth,
  ProviderAuthMethod,
  ProviderOAuthAuthorization,
  SelectedModel,
} from "@/types/electron";

export interface HarnessTarget {
  /** Harness scope: on-disk project root for session list and execution. */
  directory?: string;
  /**
   * Frontend connection routing only (multi-workspace UI). Not Harness scope identity;
   * execution payloads use `directory` + `harnessId`.
   */
  workspaceId?: string;
  baseUrl?: string;
  authToken?: string;
}

export interface HarnessCapabilities {
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
  config: boolean;
  localServer: boolean;
}

interface HarnessConnectionProfile {
  kind: "remote-server" | "local-cli";
  fields: {
    serverUrl: boolean;
    username: boolean;
    password: boolean;
    directory: boolean;
  };
}

interface HarnessSessionStatus {
  type: string;
}

export type HarnessEvent =
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
      id?: string;
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
  | { type: "session.status"; sessionID: string; status: HarnessSessionStatus }
  | { type: "permission.requested"; request: PermissionRequest }
  | { type: "permission.cleared"; sessionID: string }
  | { type: "question.requested"; request: QuestionRequest }
  | { type: "question.cleared"; sessionID: string }
  | { type: "session.error"; error: string; sessionID?: string };

interface HarnessRuntime {
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
  compactSession(sessionId: string, model?: SelectedModel, target?: HarnessTarget): Promise<void>;
  forkSession(sessionId: string, messageID?: string, target?: HarnessTarget): Promise<Session>;
  revertSession(
    sessionId: string,
    messageID: string,
    partID?: string,
    target?: HarnessTarget,
  ): Promise<Session>;
  unrevertSession(sessionId: string, target?: HarnessTarget): Promise<Session>;
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

interface HarnessPlatform {
  server?: {
    start(): Promise<{ alreadyRunning?: boolean }>;
    stop(): Promise<{ alreadyStopped?: boolean; pid?: number }>;
    status(): Promise<{ running: boolean }>;
  };
  providers?: {
    listAll(target?: HarnessTarget): Promise<AllProvidersData>;
    getAuthMethods(target?: HarnessTarget): Promise<Record<string, ProviderAuthMethod[]>>;
    connect(target: HarnessTarget, providerID: string, auth: ProviderAuth): Promise<void>;
    disconnect(target: HarnessTarget, providerID: string): Promise<void>;
    oauthAuthorize(
      target: HarnessTarget,
      providerID: string,
      method?: number,
    ): Promise<ProviderOAuthAuthorization>;
    oauthCallback(
      target: HarnessTarget,
      providerID: string,
      method?: number,
      code?: string,
    ): Promise<boolean>;
    dispose(target?: HarnessTarget): Promise<boolean>;
  };
  mcp?: {
    status(target?: HarnessTarget): Promise<Record<string, McpStatus>>;
    add(
      target: HarnessTarget,
      name: string,
      config: McpLocalConfig | McpRemoteConfig,
    ): Promise<Record<string, McpStatus>>;
    connect(target: HarnessTarget, name: string): Promise<void>;
    disconnect(target: HarnessTarget, name: string): Promise<void>;
  };
  config?: {
    get(target?: HarnessTarget): Promise<HarnessConfig>;
    update(target: HarnessTarget, config: Partial<HarnessConfig>): Promise<HarnessConfig>;
  };
}

export interface HarnessDescriptor {
  id: string;
  label: string;
  connection: HarnessConnectionProfile;
  capabilities: HarnessCapabilities;
  runtime: HarnessRuntime;
  platform?: HarnessPlatform;
}
