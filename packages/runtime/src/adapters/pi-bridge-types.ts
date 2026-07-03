import type { PiMessageBundle } from "./pi-bridge-mapping.ts";

export type { PiBridgeProject, PiLiveSessionContext } from "./pi-project-slot.ts";

export type PiSessionIndexEntry = {
  projectKey: string;
  path?: string;
  directory: string;
  workspaceId?: string;
};

export type PiLiveState = {
  nextSeq: number;
  currentUserMessageId: string | null;
  currentAssistantMessageId: string | null;
  assistantStartedAt: number | null;
  reasoningTimesByContentIndex: Map<number, { start: number; end?: number }>;
  syntheticToReal: Map<string, string>;
  pendingAssistantResolutions: Array<{ syntheticId: string; startedAt?: number }>;
};

export type PiModelRef = {
  provider?: string;
  modelId?: string;
  variant?: string;
};

export type PiSelectedModelRef = {
  providerID?: string;
  modelID?: string;
  provider?: string;
  modelId?: string;
  variant?: string;
};

export type PiBranchMessage = {
  role?: string;
  content?: unknown;
  timestamp?: unknown;
  stopReason?: string;
  errorMessage?: string;
  provider?: string;
  model?: string;
  variant?: string;
  toolCallId?: string;
  isError?: boolean;
  details?: unknown;
  usage?: PiAssistantUsage;
};

export type PiAssistantUsage = Record<string, unknown>;

export type PiContentBlock =
  | { type: "text"; text?: string }
  | { type: "thinking"; thinking?: string; redacted?: boolean }
  | { type: "image"; mimeType?: string; data?: string }
  | { type: "toolcall"; id?: string; name?: string; arguments?: unknown }
  | { type: string; [key: string]: unknown };

export type PiToolExecutionPartial = { content?: unknown; details?: unknown };

type PiBranchEntryBase = {
  id?: string;
  timestamp?: string | number;
};

export type PiBranchCompactionEntry = PiBranchEntryBase & {
  type: "compaction";
  summary?: string;
  firstKeptEntryId?: string;
};

export type PiBranchMessageEntry = PiBranchEntryBase & {
  type: "message";
  message: PiBranchMessage;
  assistantMessageEvent?: {
    type: string;
    contentIndex: number;
  };
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  partialResult?: PiToolExecutionPartial;
  result?: PiToolExecutionPartial;
  isError?: boolean;
};

export type PiBranchModelChangeEntry = PiBranchEntryBase & {
  type: "model_change";
  provider?: string;
  modelId?: string;
};

export type PiBranchThinkingLevelChangeEntry = PiBranchEntryBase & {
  type: "thinking_level_change";
  level?: unknown;
  thinkingLevel?: unknown;
  effort?: unknown;
  value?: unknown;
  label?: unknown;
};

export type PiBranchLabelEntry = PiBranchEntryBase & {
  type: "label";
  label?: unknown;
  value?: unknown;
};

export type PiBranchBranchSummaryEntry = PiBranchEntryBase & {
  type: "branch_summary";
  summary?: string;
};

export type PiBranchCustomMessageEntry = PiBranchEntryBase & {
  type: "custom_message";
  content?: unknown;
};

export type PiBranchCustomEntry = PiBranchEntryBase & {
  type: "custom";
  content?: unknown;
  value?: unknown;
  label?: unknown;
};

/** Pi session branch entry `type` field (e.g. compaction, message, model_change, custom_message). */
export type PiBranchEntryType = string;

/**
 * Pi session branch timeline entry. Runtime entries use string `type`; use exported
 * `PiBranch*Entry` aliases when narrowing known variants.
 */
export type PiBranchEntry = {
  type: PiBranchEntryType;
  id?: string;
  provider?: string;
  modelId?: string;
  firstKeptEntryId?: string;
  timestamp?: string | number;
  summary?: string;
  content?: unknown;
  level?: unknown;
  thinkingLevel?: unknown;
  effort?: unknown;
  value?: unknown;
  label?: unknown;
  message?: PiBranchMessage;
  assistantMessageEvent?: {
    type: string;
    contentIndex: number;
  };
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  partialResult?: PiToolExecutionPartial;
  result?: PiToolExecutionPartial;
  isError?: boolean;
};

export interface PiSessionManagerLike {
  getBranch(): PiBranchEntry[];
  getSessionId(): string;
  getCwd(): string;
  getSessionName(): string;
  getHeader(): { timestamp: string };
  open?(path: string, ...args: unknown[]): PiSessionManagerLike;
}

export type PiPromptImage = {
  type: "image";
  data: string;
  mimeType: string;
};

export type PiPromptArgs = {
  sessionId?: string;
  text?: string;
  images?: unknown;
  model?: PiSelectedModelRef;
  agent?: string;
  variant?: string;
  directory?: string;
  workspaceId?: string;
};

export type PiStartSessionInput = {
  directory?: string;
  workspaceId?: string;
  title?: string;
  text?: string;
  images?: unknown;
  model?: PiSelectedModelRef;
  agent?: string;
  variant?: string;
};

export type PiSessionCreatePayload = {
  title?: string;
  directory?: string;
  workspaceId?: string;
};

export type PiProviderAuthPayload =
  | { type: "api"; key: string }
  | { type: string; [key: string]: unknown };

export type PiOAuthAuthInfo = {
  url: string;
  method: string;
  instructions: string;
};

export type PiLiveSessionLike = {
  sessionId: string;
  sessionName?: string;
  sessionFile?: string;
  sessionManager: PiSessionManagerLike;
  subscribe: (handler: (event: PiNativeSessionEvent) => void) => () => void;
  isStreaming?: boolean;
  isCompacting?: boolean;
  prompt?: (text: string, options?: Record<string, unknown>) => Promise<unknown>;
  abort?: () => Promise<unknown>;
  compact?: () => Promise<unknown>;
  setModel?: (model: unknown) => Promise<unknown>;
  setThinkingLevel?: (level: string) => void;
  setSessionName?: (name: string) => void;
  model?: unknown;
  modelRegistry?: {
    refresh?: () => void;
    getAvailable: () => unknown[];
    authStorage?: { reload?: () => void };
  };
  extensionRunner?: { getRegisteredCommands: () => unknown[] };
  promptTemplates?: unknown[];
  resourceLoader?: { getSkills: () => { skills: unknown[] } };
};

/** @see PiNativeSessionEvent — common Pi agent session event type literals */
export type PiNativeSessionEventType = string;

export type PiNativeSessionEvent = {
  type: string;
  toolResults?: unknown[];
  message?: PiBranchMessage & { role: string };
  assistantMessageEvent?: {
    type: string;
    contentIndex?: number;
  };
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  partialResult?: PiToolExecutionPartial;
  result?: PiToolExecutionPartial;
  isError?: boolean;
};

export type PiSessionCache = {
  messages: PiMessageBundle[];
};

export type PiConnectionStatusPayload = Record<string, unknown>;

export type PiBackendSessionStatusPayload = {
  type: "session.status";
  sessionID: string;
  status: { type: string; [key: string]: unknown };
};

export type PiBackendMessageUpdatedPayload = {
  type: "message.updated";
  message: Record<string, unknown>;
};

export type PiBackendMessagePartUpdatedPayload = {
  type: "message.part.updated";
  part: Record<string, unknown>;
};

export type PiBackendSessionCreatedPayload = {
  type: "session.created";
  directory: string;
  workspaceId?: string;
  session: Record<string, unknown>;
};

export type PiBackendSessionUpdatedPayload = {
  type: "session.updated";
  directory: string;
  workspaceId?: string;
  session: Record<string, unknown>;
};

export type PiBackendSessionDeletedPayload = {
  type: "session.deleted";
  directory: string;
  workspaceId?: string;
  sessionId: string;
};

export type PiBackendSessionErrorPayload = {
  type: "session.error";
  error: string;
  sessionID: string;
};

export type PiBackendMessageReplacedPayload = {
  type: "message.replaced";
  [key: string]: unknown;
};

export type PiBackendEvent =
  | PiBackendSessionStatusPayload
  | PiBackendMessageUpdatedPayload
  | PiBackendMessagePartUpdatedPayload
  | PiBackendSessionCreatedPayload
  | PiBackendSessionUpdatedPayload
  | PiBackendSessionDeletedPayload
  | PiBackendSessionErrorPayload
  | PiBackendMessageReplacedPayload
  | { type: string; [key: string]: unknown };

export type PiHarnessPiEvent = {
  type: "pi:event";
  directory: string;
  workspaceId?: string;
  payload: PiBackendEvent | Record<string, unknown>;
};

export type PiHarnessConnectionStatusEvent = {
  type: "connection:status";
  directory: string;
  workspaceId?: string;
  payload: PiConnectionStatusPayload;
};

export type PiHarnessNativeEvent = PiHarnessPiEvent | PiHarnessConnectionStatusEvent;

/** @deprecated Use PiHarnessNativeEvent */
export type HarnessBridgeNativeEvent = PiHarnessNativeEvent;

export type PiOAuthAuthorization = PiOAuthAuthInfo;

export type PiOAuthPendingFlow = {
  done: boolean;
  error: Error | null;
  authorization: PiOAuthAuthorization | null;
  resolveManualCode: ((code: string) => void) | null;
  rejectManualCode: ((reason: Error) => void) | null;
  promise: Promise<boolean> | null;
};
