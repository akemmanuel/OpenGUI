import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { OpencodeProjectRegistry } from "./opencode-project-registry.ts";

export type OpenCodeSdkClient = ReturnType<typeof createOpencodeClient>;

export type OpenCodeConnectConfig = {
  baseUrl: string;
  username?: string;
  password?: string;
  directory?: string;
};

export type OpenCodeLocalServerStartData = {
  alreadyRunning?: boolean;
  alreadyStopped?: boolean;
  stoppedUnhealthy?: boolean;
};

export type OpenCodeLocalServerOpResult =
  | { success: true; data?: OpenCodeLocalServerStartData }
  | { success: false; error: string; logs?: string | null };

export type OpenCodeServerProcessInfo = {
  pid: number;
  command: string | null;
};

export type OpenCodeHealthSnapshot = {
  healthy: boolean;
  version: string | null;
};

export type OpenCodeSdkResultEnvelope<T = unknown> = {
  data?: T;
  error?: { message?: string };
  response?: { ok?: boolean; status?: number; statusText?: string; headers?: Headers };
};

export class OpenCodeHttpError extends Error {
  status?: number;
  data?: unknown;

  constructor(message: string, init?: { status?: number; data?: unknown }) {
    super(message);
    this.name = "OpenCodeHttpError";
    this.status = init?.status;
    this.data = init?.data;
  }
}

export type OpenCodePromptTextPart = { type: "text"; text: string };
export type OpenCodePromptFilePart = { type: "file"; mime: string; url: string };
export type OpenCodePromptPart = OpenCodePromptTextPart | OpenCodePromptFilePart;

export type OpenCodeModelRef = {
  providerID?: string;
  modelID?: string;
};

export type OpenCodeSessionStartInput = {
  directory?: string;
  workspaceId?: string;
  title?: string;
  text?: string;
  images?: string[];
  model?: OpenCodeModelRef;
  agent?: string;
  variant?: string;
};

export type OpenCodeProjectAddConfig = OpenCodeConnectConfig & {
  workspaceId?: string;
};

export type OpenCodeMessagesOptions = {
  limit?: number;
  before?: string;
};

export type OpenCodeIpcSuccess<T = unknown> = { success: true; data?: T; status?: unknown };
export type OpenCodeIpcFailure = { success: false; error: string };
export type OpenCodeIpcResult<T = unknown> = OpenCodeIpcSuccess<T> | OpenCodeIpcFailure;

export type HarnessWebContentsSender = {
  id: number;
  once(event: string, listener: () => void): void;
  isDestroyed?: () => boolean;
  send(channel: string, event: unknown): void;
};

export type OpenCodeWindowBridgeState<Conn> = {
  projectRegistry: OpencodeProjectRegistry<Conn>;
  pendingConnections: Map<string, Promise<Conn | null>>;
  sessionDirectories: Map<string, string>;
  serverConfig: OpenCodeConnectConfig | null;
};

export type OpenCodeRunCommandError = Error & {
  stdout?: string;
  stderr?: string;
};

export type OpenCodeTaggedSession = Record<string, unknown> & {
  id: string;
  slug?: string;
  directory?: string;
  _harnessId?: string;
  _rawId?: string;
  _projectDir?: string;
  _workspaceId?: string;
};

export type OpenCodeMessageEntry = {
  info?: Record<string, unknown> & { sessionID?: string; summary?: Record<string, unknown> };
  parts?: Array<Record<string, unknown>>;
};