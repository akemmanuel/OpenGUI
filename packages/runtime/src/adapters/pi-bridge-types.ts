import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
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

/** Harness UI model selection (providerID/modelID or provider/modelId). */
export type PiModelSelection = {
  providerID?: string;
  modelID?: string;
  provider?: string;
  modelId?: string;
};

/** Shared project target shape used across Pi RPC handlers. */
export type PiProjectTarget = {
  directory?: string;
  workspaceId?: string;
};

export type PiSessionCreatePayload = {
  title?: string;
  directory?: string;
  workspaceId?: string;
};

export type PiStartSessionInput = {
  directory?: string;
  workspaceId?: string;
  title?: string;
  text?: string;
  images?: unknown;
  model?: PiModelSelection;
  agent?: string;
  variant?: string;
};

export type PiPromptArgs = {
  sessionId?: string;
  text?: string;
  images?: unknown;
  model?: PiModelSelection;
  agent?: string;
  variant?: string;
  directory?: string;
  workspaceId?: string;
};

export type PiProviderAuthPayload =
  | { type: "api"; key: string }
  | { type: string; [key: string]: unknown };

/** Content blocks carried by Pi branch messages. */
export type PiContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "tool"; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

export type PiBranchEntry = {
  type: string;
  id: string;
  parentId?: string | null;
  provider?: string;
  modelId?: string;
  firstKeptEntryId?: string;
  timestamp: string | number;
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
    usage?: {
      cost?: { total?: number };
      totalTokens?: number;
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    details?: unknown;
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

/**
 * Structural subset of the SDK `SessionManager` that the Pi bridge depends on.
 * Kept as an interface so test doubles can satisfy it via `as` casts, while the
 * real `SessionManager` remains structurally assignable.
 */
export interface PiSessionManagerLike {
  getBranch(): PiBranchEntry[];
  getSessionId(): string;
  getCwd(): string;
  getSessionName(): string | undefined;
  getHeader(): { timestamp: string } | null;
  open?(path: string, ...args: unknown[]): PiSessionManagerLike;
}

/** The Pi bridge operates on real `AgentSession` instances from the SDK. */
export type PiLiveSessionLike = AgentSession;

export type PiNativeSessionEvent = {
  type: string;
  message?: PiBranchEntry["message"] & { role: string };
  assistantMessageEvent?: PiBranchEntry["assistantMessageEvent"];
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  partialResult?: PiBranchEntry["partialResult"];
  result?: PiBranchEntry["result"];
  isError?: boolean;
  usage?: unknown;
  toolResults?: unknown;
  [key: string]: unknown;
};

export type PiSessionCache = {
  messages: PiMessageBundle[];
};

/** Runtime shape stored per live Pi session (services + diagnostics included). */
export type PiLiveSessionRuntime = AgentSessionRuntime;

export type HarnessBridgeNativeEvent = Record<string, unknown>;

export type PiConnectionStatusPayload = Record<string, unknown>;

// Re-export SDK types that bridge modules reference directly.
export type { SessionManager };
