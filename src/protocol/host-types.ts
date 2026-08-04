// Compatibility exports. Canonical shared domain shapes live outside the host
// transport contract so renderer and preload types cannot drift from it.
export type { SelectedModel } from "@opengui/protocol";
export type { ConnectionStatus } from "@/types/connection";
export type { Workspace } from "@/types/workspace";

export interface HostModelConnection {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
  modelIds: string[];
  defaultModelId?: string;
  modelRoutes?: Record<string, "openai-chat" | "anthropic-messages" | "responses">;
  plane?: "host" | "team" | "user";
  ownerType?: "host" | "team" | "user";
  ownerId?: string;
  credentialKind?: "byok" | "byos";
  modelCapabilities?: Record<
    string,
    {
      displayName?: string;
      context?: number;
      reasoning: boolean;
      reasoningEfforts?: ReasoningEffort[];
    }
  >;
}

export interface HostModelOffering {
  id: string;
  displayName: string;
  description: string | null;
  /** Administrative route details are omitted from member/viewer payloads. */
  backendId?: string;
  upstreamModelId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface HostMcpConnectionStatus {
  state: "disabled" | "refreshing" | "ready" | "degraded" | "offline";
  toolCount: number;
  lastCheckedAt?: string;
  problem?: {
    code: string;
    stage: string;
    message: string;
    retryable: boolean;
  };
}

export type HostMcpConnection = (
  | {
      id: string;
      label: string;
      enabled: boolean;
      transport: {
        kind: "stdio";
        command: string;
        args: string[];
        cwd?: string;
        envKeys: string[];
      };
    }
  | {
      id: string;
      label: string;
      enabled: boolean;
      transport: { kind: "http"; url: string; bearerTokenConfigured: boolean };
    }
) & { status?: HostMcpConnectionStatus };

export type HostMcpConnectionMutation =
  | {
      id: string;
      label: string;
      enabled: boolean;
      commandApproved: true;
      transport: {
        kind: "stdio";
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
      };
    }
  | {
      id: string;
      label: string;
      enabled: boolean;
      transport: { kind: "http"; url: string; bearerToken?: string };
    };

export interface HostMcpToolInfo {
  name: string;
  title: string;
  description: string;
}

export interface HostProject {
  directory: string;
  name: string;
}

export interface HostSkill {
  name: string;
  description: string;
  source: "host" | "project";
  /** True when the skill is user-invoked only (not auto-advertised to the model). */
  manual: boolean;
}

export interface HostInstalledSkill extends HostSkill {
  location: string;
}

export type HostSkillScope = "project" | "host";

export interface HostSkillInstallation {
  name: string;
  description: string;
  manual: boolean;
  scope: HostSkillScope;
  location: string;
  managed: boolean;
  modified: boolean;
  generation: number;
  source?: string;
  resolvedSource?: string;
  revision?: string;
}

export interface HostSkillSourceDescriptor {
  kind: "github";
  grammar: "github:OWNER/REPOSITORY/PATH@REF";
  example: string;
  mutableRefsResolved: true;
  legacyGrammar: "OWNER/REPOSITORY@SKILL";
}

export interface HostSkillMutation {
  scope: HostSkillScope;
  directory?: string;
  requestId: string;
  expectedGeneration?: number;
}

export interface HostSessionSummary {
  id: string;
  projectDirectory: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: "idle" | "running" | "failed" | "interrupted" | "stopped";
  accessRole?: "view" | "run" | "admin" | "owner" | null;
  shared?: boolean;
}

/** Persisted attribution only; authorization continues to come from the Host credential. */
export interface ActorSnapshot {
  type: "user" | "api_key" | "local";
  id: string;
  displayName: string;
}

export interface HostSessionEntry {
  id: string;
  sessionId: string;
  sequence: number;
  kind: string;
  payload: Record<string, unknown> & { actor?: ActorSnapshot };
  createdAt: string;
}

export interface HostPrompt {
  text: string;
  actor?: ActorSnapshot;
}

export interface HostFollowUp {
  id: string;
  sequence: number;
  prompt: HostPrompt;
  createdAt: string;
}

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export interface HostSessionSnapshot extends HostSessionSummary {
  model: { connectionId: string; modelId: string } | null;
  reasoning: ReasoningEffort | null;
  entries: HostSessionEntry[];
  followUps: HostFollowUp[];
}

export interface HostEvent {
  sessionId: string;
  event:
    | { type: "assistant_delta"; runId: string; delta: string }
    | { type: "reasoning_delta"; runId: string; delta: string }
    | { type: "entry_appended"; entry: HostSessionEntry };
}

export interface OpenGuiHostClient {
  codexAuthStatus(): Promise<CodexAuthStatus>;
  beginCodexAuth(): Promise<CodexAuthStatus>;
  pollCodexAuth(): Promise<CodexAuthStatus>;
  cancelCodexAuth(): Promise<CodexAuthStatus>;
  disconnectCodex(): Promise<void>;
  subscriptionAuthStatus(provider: SubscriptionProvider): Promise<CodexAuthStatus>;
  beginSubscriptionAuth(provider: SubscriptionProvider): Promise<CodexAuthStatus>;
  pollSubscriptionAuth(provider: SubscriptionProvider): Promise<CodexAuthStatus>;
  cancelSubscriptionAuth(provider: SubscriptionProvider): Promise<CodexAuthStatus>;
  disconnectSubscription(provider: SubscriptionProvider): Promise<void>;
  health(): Promise<{ ok: true; version: string; shell: string }>;
  listModelConnections(): Promise<HostModelConnection[]>;
  listModelOfferings(): Promise<HostModelOffering[]>;
  upsertModelConnection(connection: HostModelConnection): Promise<HostModelConnection>;
  removeModelConnection(connectionId: string): Promise<void>;
  listMcpConnections(): Promise<HostMcpConnection[]>;
  upsertMcpConnection(connection: HostMcpConnectionMutation): Promise<HostMcpConnection>;
  inspectMcpConnection(connectionId: string): Promise<HostMcpToolInfo[]>;
  removeMcpConnection(connectionId: string): Promise<void>;
  listProjects(): Promise<HostProject[]>;
  registerProject(directory: string): Promise<HostProject>;
  unregisterProject(directory: string): Promise<void>;
  listSkills(directory: string): Promise<HostSkill[]>;
  supportedSkillSources(): Promise<HostSkillSourceDescriptor[]>;
  listSkillInstallations(
    scope: HostSkillScope,
    directory?: string,
  ): Promise<HostSkillInstallation[]>;
  installManagedSkill(
    input: HostSkillMutation & { source: string },
  ): Promise<HostSkillInstallation>;
  updateManagedSkill(name: string, input: HostSkillMutation): Promise<HostSkillInstallation>;
  removeManagedSkill(name: string, input: HostSkillMutation): Promise<void>;
  installSkill(source: string, directory: string, global: boolean): Promise<HostInstalledSkill>;
  removeSkill(name: string, directory: string, global: boolean): Promise<void>;
  listSessions(directory: string): Promise<HostSessionSummary[]>;
  searchSessionMessages(directories: readonly string[], query: string): Promise<string[]>;
  createSession(input: {
    directory: string;
    title?: string;
    model?: { connectionId: string; modelId: string };
    reasoning?: ReasoningEffort;
  }): Promise<HostSessionSnapshot>;
  readSession(sessionId: string): Promise<HostSessionSnapshot>;
  renameSession(sessionId: string, title: string): Promise<HostSessionSnapshot>;
  deleteSession(sessionId: string): Promise<void>;
  setModel(
    sessionId: string,
    model: { connectionId: string; modelId: string },
  ): Promise<HostSessionSnapshot>;
  setReasoning(sessionId: string, reasoning: ReasoningEffort): Promise<HostSessionSnapshot>;
  compact(sessionId: string): Promise<{ startedEntries: HostSessionEntry[] }>;
  prompt(
    sessionId: string,
    text: string,
    options?: { skills?: string[]; interrupt?: boolean },
  ): Promise<
    | { mode: "run"; startedEntries: HostSessionEntry[] }
    | { mode: "follow_up"; followUp: HostFollowUp }
  >;
  updateFollowUp(sessionId: string, followUpId: string, text: string): Promise<HostFollowUp[]>;
  reorderFollowUp(sessionId: string, followUpId: string, index: number): Promise<HostFollowUp[]>;
  removeFollowUp(sessionId: string, followUpId: string): Promise<HostFollowUp[]>;
  sendFollowUpNow(sessionId: string, followUpId: string): Promise<HostFollowUp[]>;
  abort(sessionId: string): Promise<void>;
  findFiles(directory: string, query: string): Promise<string[]>;
  subscribe(
    listener: (event: HostEvent) => void,
    sessionId?: string,
    onReady?: () => void,
  ): () => void;
}
export interface CodexAuthStatus {
  connected: boolean;
  pending: { userCode: string; verificationUri: string; expiresAt: number } | null;
}
export type SubscriptionProvider = "xai";
