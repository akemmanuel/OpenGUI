export interface HostModelConnection {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
  modelIds: string[];
  defaultModelId?: string;
  modelRoutes?: Record<string, "openai-chat" | "anthropic-messages" | "responses">;
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

export interface HostProject {
  directory: string;
  name: string;
}

export interface HostSessionSummary {
  id: string;
  projectDirectory: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: "idle" | "running" | "failed" | "interrupted" | "stopped";
}

export interface HostSessionEntry {
  id: string;
  sessionId: string;
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface HostFollowUp {
  id: string;
  sequence: number;
  prompt: { text: string };
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
  disconnectCodex(): Promise<void>;
  subscriptionAuthStatus(provider: SubscriptionProvider): Promise<CodexAuthStatus>;
  beginSubscriptionAuth(provider: SubscriptionProvider): Promise<CodexAuthStatus>;
  pollSubscriptionAuth(provider: SubscriptionProvider): Promise<CodexAuthStatus>;
  disconnectSubscription(provider: SubscriptionProvider): Promise<void>;
  health(): Promise<{ ok: true; version: string; shell: string }>;
  listModelConnections(): Promise<HostModelConnection[]>;
  upsertModelConnection(connection: HostModelConnection): Promise<HostModelConnection>;
  removeModelConnection(connectionId: string): Promise<void>;
  listProjects(): Promise<HostProject[]>;
  registerProject(directory: string): Promise<HostProject>;
  unregisterProject(directory: string): Promise<void>;
  listSessions(directory: string): Promise<HostSessionSummary[]>;
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
  prompt(sessionId: string, text: string): Promise<{ mode: "run" | "follow_up" }>;
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
