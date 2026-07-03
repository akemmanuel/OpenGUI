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

export type PiBranchEntry = {
  type: string;
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
  message?: {
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
    usage?: Record<string, unknown>;
  };
  assistantMessageEvent?: {
    type: string;
    contentIndex: number;
  };
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  partialResult?: { content?: unknown; details?: unknown };
  result?: { content?: unknown; details?: unknown };
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

export type PiNativeSessionEvent = {
  type: string;
  toolResults?: unknown[];
  message?: PiBranchEntry["message"] & { role: string };
  assistantMessageEvent?: {
    type: string;
    contentIndex?: number;
  };
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  partialResult?: PiBranchEntry["partialResult"];
  result?: PiBranchEntry["result"];
  isError?: boolean;
};

export type PiSessionCache = {
  messages: PiMessageBundle[];
};

export type HarnessBridgeNativeEvent = Record<string, unknown>;

export type PiConnectionStatusPayload = Record<string, unknown>;

export type PiOAuthAuthorization = {
  url: string;
  method: string;
  instructions: string;
};

export type PiOAuthPendingFlow = {
  done: boolean;
  error: Error | null;
  authorization: PiOAuthAuthorization | null;
  resolveManualCode: ((code: string) => void) | null;
  rejectManualCode: ((reason: Error) => void) | null;
  promise: Promise<boolean> | null;
};
