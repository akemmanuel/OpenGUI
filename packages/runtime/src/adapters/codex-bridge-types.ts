import type { buildCodexProviderFromModels } from "./codex-models.ts";

export type CodexMessageInfo = Record<string, unknown> & {
  id: string;
  sessionID?: string;
  role?: string;
  time?: { created?: number; completed?: number };
  tokens?: {
    input: number;
    output: number;
    reasoning?: number;
    cache?: { read: number; write: number };
  };
  model?: { modelID?: string; variant?: string; providerID?: string };
  modelID?: string;
  variant?: string;
  parentID?: string;
};

export type CodexPart = Record<string, unknown> & {
  id?: string;
  messageID?: string;
  sessionID?: string;
  type?: string;
  text?: string;
  time?: { start?: number; end?: number };
};

export type CodexMessageBundle = {
  info: CodexMessageInfo;
  parts: CodexPart[];
};

export type CodexToolPartState = {
  time?: { start?: number; end?: number };
  status?: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  title?: string;
  metadata?: Record<string, unknown>;
};

export type CodexToolPart = CodexPart & {
  type: "tool";
  callID?: string;
  tool?: string;
  state?: CodexToolPartState;
};

export type NormalizedAppServerItem = {
  id: string;
  type: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: Array<{ path: string; kind: string }>;
  server?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  result?: { content?: unknown[]; structured_content?: unknown; message?: string };
  error?: { message?: string };
  query?: string;
  items?: Array<{ text?: string; completed?: boolean }>;
  aggregatedOutput?: string;
  exitCode?: number | null;
};

export type CodexProviderData = ReturnType<typeof buildCodexProviderFromModels>;

export type CodexModelRow = {
  id?: string;
  variants?: Record<string, { disabled?: boolean }>;
};

export type CodexSelectedModel = { modelID?: string } | null | undefined;

export type CodexAppServerThreadRow = {
  id?: string;
  createdAt?: number;
  updatedAt?: number;
  cwd?: string;
  name?: string;
  preview?: string;
};

export type CodexJsonRpcPending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type CodexMcpContentBlock = {
  type?: string;
  text?: string;
};

export type CodexTurnUsage = {
  input_tokens?: number;
  output_tokens?: number;
};

export type CodexAppServerNotificationParams = {
  thread?: { id?: string };
  item?: Record<string, unknown>;
  itemId?: string;
  delta?: string;
  turn?: {
    usage?: CodexTurnUsage;
    status?: string;
    error?: { message?: string };
  };
  error?: { message?: string };
  message?: string;
};

export type CodexSessionView = Record<string, unknown> & {
  id: string;
  title?: string;
  time?: { created?: number; updated?: number };
  model?: { providerID?: string; id?: string; variant?: string };
};

export type CodexPromptInput = {
  directory?: string;
  workspaceId?: string;
  title?: string;
  text?: string;
  images?: unknown;
  model?: CodexSelectedModel;
  agent?: unknown;
  variant?: string;
};
