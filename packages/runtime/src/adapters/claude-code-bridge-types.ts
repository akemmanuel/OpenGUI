import type {
  ClaudeAgentOptions,
  PermissionMode,
  PermissionResult,
  ToolPermissionContext,
} from "../../../claude-agent-sdk-lite/dist/index.js";
import type { SDKQuery } from "../../../claude-agent-sdk-lite/dist/index.js";
import type { ClaudeSupportedModel } from "./claude-code-models.ts";

export type { ClaudeAgentOptions, PermissionMode, PermissionResult, ToolPermissionContext };

export type ClaudeProjectTarget = { directory?: string; workspaceId?: string };

export type ClaudeProjectSlot = {
  key?: string;
  directory: string;
  workspaceId?: string;
};

export type ClaudeMessageInfo = Record<string, unknown> & {
  id: string;
  sessionID?: string;
  role?: string;
  time?: { created?: number; completed?: number };
  modelID?: string;
  providerID?: string;
};

export type ClaudeToolPartState = {
  status?: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: { start?: number; end?: number };
};

export type ClaudeMessagePart = Record<string, unknown> & {
  id: string;
  sessionID?: string;
  messageID?: string;
  type?: string;
  text?: string;
  callID?: string;
  tool?: string;
  state?: ClaudeToolPartState;
  synthetic?: boolean;
  time?: { start?: number };
};

export type ClaudeMessageBundle = {
  info: ClaudeMessageInfo;
  parts: ClaudeMessagePart[];
};

export type ClaudeProviderCatalog = {
  loadedAt: number;
  target: ClaudeProjectTarget & { directory: string };
  supportedModels: ClaudeSupportedModel[];
  providers: unknown;
};

export type ClaudePendingPermission = {
  resolve: (result: PermissionResult) => void;
  input: Record<string, unknown>;
  suggestions: PermissionUpdate[];
  toolUseID?: string;
};

export type PermissionUpdate =
  | { type: "setMode"; mode: string; destination: string }
  | { type: "addDirectories" | "removeDirectories"; directories: string[]; destination: string }
  | {
      type: "addRules" | "replaceRules" | "removeRules";
      rules: Array<{ toolName: string; ruleContent?: string }>;
      behavior: string;
      destination: string;
    };

export type ClaudeActiveQueryEntry = {
  query?: SDKQuery;
  directory: string;
  workspaceId?: string;
  model?: { modelID?: string };
  variant?: string;
  pendingPermissions: Map<string, ClaudePendingPermission>;
};

export type ClaudePlaceholderSession = {
  id: string;
  target: ClaudeProjectTarget & { directory: string };
  title?: string;
};

export type ClaudePendingTempState = {
  sessionId: string;
  tempSessionId: string | null;
  target: ClaudeProjectTarget & { directory: string };
  query: SDKQuery | null;
  resolveSession: ((value: unknown) => void) | null;
  rejectSession: ((reason: unknown) => void) | null;
  fallbackTitle: string;
  promptText: string;
  model?: { modelID?: string };
  variant?: string;
  syntheticUserId: string;
  syntheticUserEmitted: boolean;
  currentAssistantMessageId: string | null;
  currentMessageParts: Map<string, ClaudeMessagePart>;
  toolParts: Map<string, ClaudeMessagePart>;
  replacedFromSessionId?: string;
};

export type MakeClaudeQueryOptionsInput = {
  cwd?: string;
  model?: string;
  permissionMode?: PermissionMode;
  includePartialMessages?: boolean;
  canUseTool?: ClaudeAgentOptions["canUseTool"];
  variant?: string;
  modelInfo?: ClaudeSupportedModel | null;
  resume?: string;
  probe?: boolean;
  title?: string;
};

export type ClaudeGetMessagesOptions = {
  limit?: number;
  before?: string | null;
};

export type HarnessModelRef = {
  modelID?: string;
};

export type StartQueryParams = {
  sessionId?: string;
  text?: string;
  title?: string;
  directory?: string;
  workspaceId?: string;
  model?: HarnessModelRef;
  variant?: string;
};

export type PromptParams = {
  sessionId: string;
  text: string;
  images?: unknown;
  model?: HarnessModelRef;
  agent?: unknown;
  variant?: string;
  directory?: string;
  workspaceId?: string;
};

/** User permission reply from the renderer (IPC). */
export type ClaudePermissionResponse = "always" | "once" | "reject";

export type ClaudeBridgeEvent =
  | {
      type: "connection:status";
      directory?: string;
      workspaceId?: string;
      payload: Record<string, unknown>;
    }
  | { type: "claude-code:event"; payload: Record<string, unknown> };

export type ClaudeSessionModelSelection = {
  providerID: string;
  id: string;
  variant?: string;
};
