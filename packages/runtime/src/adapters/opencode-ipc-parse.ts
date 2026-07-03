/**
 * Narrow unknown OpenCode IPC / health / permission payloads.
 */
import type {
  OpenCodeCommandArguments,
  OpenCodeConfigPatch,
  OpenCodeHealthSnapshot,
  OpenCodeMcpServerConfig,
  OpenCodeModelRef,
  OpenCodeProviderAuthPayload,
  OpenCodeSessionStartInput,
} from "./opencode-bridge-types.ts";
import { asHarnessString, isRecord } from "./pi-bridge-rpc.ts";

export type OpenCodePermissionResponse = "always" | "once" | "reject";

export function ipcModelRef(value: unknown): OpenCodeModelRef | undefined {
  if (!isRecord(value)) return undefined;
  const providerID =
    typeof value.providerID === "string"
      ? value.providerID
      : typeof value.providerId === "string"
        ? value.providerId
        : undefined;
  const modelID =
    typeof value.modelID === "string"
      ? value.modelID
      : typeof value.modelId === "string"
        ? value.modelId
        : undefined;
  if (!providerID && !modelID) return undefined;
  return { providerID, modelID };
}

export function parsePermissionResponse(value: unknown): OpenCodePermissionResponse | null {
  if (value === "always" || value === "once" || value === "reject") return value;
  if (!isRecord(value)) return null;
  const response = value.response ?? value.reply;
  if (response === "always" || response === "once" || response === "reject") {
    return response;
  }
  return null;
}

export function parseOpenCodeHealthJson(data: unknown): OpenCodeHealthSnapshot {
  if (!isRecord(data)) {
    return { healthy: false, version: null };
  }
  const version = typeof data.version === "string" ? data.version : null;
  return {
    healthy: data.healthy === true,
    version,
  };
}

function tryParseJsonString(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

/** Parse daemon SSE / IPC event bodies (JSON string or already-parsed object). */
export function parseDaemonEvent(raw: unknown): Record<string, unknown> | null {
  const value = typeof raw === "string" ? tryParseJsonString(raw) : raw;
  if (!isRecord(value)) return null;
  return value;
}

export function parseOpenCodeProviderAuth(auth: unknown): OpenCodeProviderAuthPayload | null {
  if (!isRecord(auth)) return null;
  return auth as OpenCodeProviderAuthPayload;
}

export function parseOpenCodeMcpConfig(config: unknown): OpenCodeMcpServerConfig | null {
  if (!isRecord(config)) return null;
  return config as OpenCodeMcpServerConfig;
}

export function parseOpenCodeConfigPatch(config: unknown): OpenCodeConfigPatch | null {
  if (!isRecord(config)) return null;
  return config as OpenCodeConfigPatch;
}

export function parseOpenCodeCommandArguments(args: unknown): OpenCodeCommandArguments {
  if (args === null || args === undefined) return {};
  if (typeof args === "string" || typeof args === "number" || typeof args === "boolean") {
    return args;
  }
  if (Array.isArray(args)) return args as OpenCodeCommandArguments;
  if (isRecord(args)) return args as OpenCodeCommandArguments;
  return {};
}

export function parseOpenCodeSessionStartInput(input: unknown): OpenCodeSessionStartInput {
  if (!isRecord(input)) return {};
  return {
    directory: asHarnessString(input.directory),
    workspaceId: asHarnessString(input.workspaceId),
    title: asHarnessString(input.title),
    text: asHarnessString(input.text),
    images: Array.isArray(input.images)
      ? input.images.filter((item): item is string => typeof item === "string")
      : undefined,
    model: ipcModelRef(input.model),
    agent: asHarnessString(input.agent),
    variant: asHarnessString(input.variant),
  };
}
