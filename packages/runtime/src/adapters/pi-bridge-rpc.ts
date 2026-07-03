/** IPC argument narrowing for Pi harness RPC handlers. */

import type {
  HarnessBridgeNativeEvent,
  PiPromptArgs,
  PiProviderAuthPayload,
  PiSessionCreatePayload,
  PiStartSessionInput,
} from "./pi-bridge-types.ts";

export type PiProjectTarget = { directory?: string; workspaceId?: string };

export function asHarnessString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parsePiProjectTarget(directory: unknown, workspaceId?: unknown): PiProjectTarget {
  return {
    directory: asHarnessString(directory),
    workspaceId: asHarnessString(workspaceId),
  };
}

/** Daemon client sends `[target]` as a single object; unwrap like `addProject`. */
export function parsePiProjectTargetArg(args: unknown[]): PiProjectTarget {
  const first = args[0];
  if (isRecord(first)) {
    return parsePiProjectTarget(first.directory, first.workspaceId);
  }
  return parsePiProjectTarget(args[0], args[1]);
}

export function parsePiSessionCreateInput(
  title: unknown,
  directory: unknown,
  workspaceId: unknown,
): PiSessionCreatePayload {
  return {
    title: asHarnessString(title),
    directory: asHarnessString(directory),
    workspaceId: asHarnessString(workspaceId),
  };
}

export function parsePiSessionCreatePayload(...values: unknown[]): PiSessionCreatePayload {
  if (values.length >= 3) {
    return parsePiSessionCreateInput(values[0], values[1], values[2]);
  }
  const first = values[0];
  if (isRecord(first)) {
    return {
      title: asHarnessString(first.title),
      directory: asHarnessString(first.directory),
      workspaceId: asHarnessString(first.workspaceId),
    };
  }
  return {};
}

export function parsePiStartSessionInput(...values: unknown[]): PiStartSessionInput {
  const first = values.length === 1 ? values[0] : values[0];
  if (!isRecord(first)) return {};
  const record = first;
  return {
    directory: asHarnessString(record.directory),
    workspaceId: asHarnessString(record.workspaceId),
    title: asHarnessString(record.title),
    text: asHarnessString(record.text),
    images: record.images,
    model: coerceHarnessModelRef(record.model),
    agent: asHarnessString(record.agent),
    variant: coerceVariant(record.variant),
  };
}

export function parsePiPromptArgs(...values: unknown[]): PiPromptArgs {
  if (values.length >= 8) {
    return {
      sessionId: asHarnessString(values[0]),
      text: asHarnessString(values[1]),
      images: values[2],
      model: coerceHarnessModelRef(values[3]),
      agent: asHarnessString(values[4]),
      variant: coerceVariant(values[5]),
      directory: asHarnessString(values[6]),
      workspaceId: asHarnessString(values[7]),
    };
  }
  const first = values[0];
  if (isRecord(first)) {
    return {
      sessionId: asHarnessString(first.sessionId),
      text: asHarnessString(first.text),
      images: first.images,
      model: coerceHarnessModelRef(first.model),
      agent: asHarnessString(first.agent),
      variant: coerceVariant(first.variant),
      directory: asHarnessString(first.directory),
      workspaceId: asHarnessString(first.workspaceId),
    };
  }
  return {};
}

export function parsePiProviderAuth(auth: unknown): PiProviderAuthPayload | null {
  if (!isRecord(auth)) return null;
  const type = asHarnessString(auth.type);
  if (type === "api" && typeof auth.key === "string") {
    return { type: "api", key: auth.key };
  }
  if (type) {
    return { type, ...auth };
  }
  return null;
}

export function parsePiSessionInput(input: unknown): Record<string, unknown> {
  if (input != null && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export type PiDaemonHealthData = { daemonVersion?: string };

export function parsePiDaemonHealthData(data: unknown): PiDaemonHealthData | null {
  if (!isRecord(data)) return null;
  const daemonVersion = data.daemonVersion;
  return {
    daemonVersion: typeof daemonVersion === "string" ? daemonVersion : undefined,
  };
}

/** Normalize harness UI model selection (providerID/modelID or provider/modelId). */
export function coerceHarnessModelRef(value: unknown):
  | {
      providerID?: string;
      modelID?: string;
      provider?: string;
      modelId?: string;
    }
  | undefined {
  if (!isRecord(value)) return undefined;
  const providerID = asHarnessString(value.providerID) ?? asHarnessString(value.provider);
  const modelID = asHarnessString(value.modelID) ?? asHarnessString(value.modelId);
  if (!providerID && !modelID) return undefined;
  return {
    providerID,
    modelID,
    provider: providerID,
    modelId: modelID,
  };
}

export function coerceVariant(value: unknown): string | undefined {
  const direct = asHarnessString(value);
  if (direct === undefined) return undefined;
  const trimmed = direct.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export type PiDaemonInfo = {
  pid?: number;
  port: number;
  token: string;
  baseUrl: string;
  startedAt?: number;
};

export function parsePiDaemonInfo(raw: unknown): PiDaemonInfo | null {
  if (!isRecord(raw)) return null;
  const port = raw.port;
  const token = raw.token;
  const baseUrl = raw.baseUrl;
  if (typeof port !== "number" || !Number.isFinite(port)) return null;
  if (typeof token !== "string" || !token) return null;
  if (typeof baseUrl !== "string" || !baseUrl) return null;
  const pid = raw.pid;
  const startedAt = raw.startedAt;
  return {
    port,
    token,
    baseUrl,
    ...(typeof pid === "number" && Number.isFinite(pid) ? { pid } : {}),
    ...(typeof startedAt === "number" && Number.isFinite(startedAt) ? { startedAt } : {}),
  };
}

export function isPiHarnessNativeEvent(value: unknown): value is HarnessBridgeNativeEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "connection:status") {
    return typeof value.directory === "string";
  }
  if (value.type === "pi:event") {
    return (
      typeof value.directory === "string" &&
      value.payload != null &&
      typeof value.payload === "object"
    );
  }
  return false;
}

/** Normalize raw daemon /rpc args before invoking PiBridgeManager methods. */
export function parsePiDaemonRpcArgs(method: string, args: unknown[]): unknown[] {
  switch (method) {
    case "addProject": {
      const first = args[0];
      if (isRecord(first)) {
        return [parsePiProjectTarget(first.directory, first.workspaceId)];
      }
      return [parsePiProjectTarget(args[0], args[1])];
    }
    case "removeProject":
      if (args.length >= 2 && (typeof args[0] === "string" || args[0] == null)) {
        return [parsePiProjectTarget(args[0], args[1])];
      }
      return [
        parsePiProjectTarget(
          isRecord(args[0]) ? args[0].directory : undefined,
          isRecord(args[0]) ? args[0].workspaceId : undefined,
        ),
      ];
    case "listSessions":
    case "getSessionStatuses":
    case "getProviders":
    case "listAllProviders":
    case "getProviderAuthMethods":
    case "disposeProviderInstance":
    case "getCommands":
      return [parsePiProjectTargetArg(args)];
    case "createSession":
      return [parsePiSessionCreatePayload(...args)];
    case "startSession":
      return [parsePiStartSessionInput(...args)];
    case "prompt":
      return [parsePiPromptArgs(...args)];
    case "deleteSession":
      return [asHarnessString(args[0]) ?? "", parsePiProjectTarget(args[1], args[2])];
    case "updateSession":
      return [
        asHarnessString(args[0]) ?? "",
        asHarnessString(args[1]) ?? "",
        parsePiProjectTarget(args[2], args[3]),
      ];
    case "forkSession":
      return [
        asHarnessString(args[0]) ?? "",
        asHarnessString(args[1]) ?? "",
        parsePiProjectTarget(args[2], args[3]),
      ];
    case "connectProvider":
      return [
        parsePiProjectTarget(args[0], args[1]),
        asHarnessString(args[2]) ?? "",
        parsePiProviderAuth(args[3]) ?? args[3],
      ];
    case "disconnectProvider":
    case "oauthAuthorize":
      return [
        parsePiProjectTarget(args[0], args[1]),
        asHarnessString(args[2]) ?? "",
        ...(method === "oauthAuthorize" ? [asHarnessString(args[3]) ?? ""] : []),
      ];
    case "oauthCallback":
      return [
        parsePiProjectTarget(args[0], args[1]),
        asHarnessString(args[2]) ?? "",
        asHarnessString(args[3]) ?? "",
        asHarnessString(args[4]) ?? "",
      ];
    case "getMessages":
      return [asHarnessString(args[0]) ?? "", args[1], parsePiProjectTarget(args[2], args[3])];
    case "abort":
      return [
        asHarnessString(args[0]) ?? "",
        asHarnessString(args[1]) ?? "",
        asHarnessString(args[2]),
      ];
    case "summarizeSession":
      return [
        asHarnessString(args[0]) ?? "",
        args[1],
        asHarnessString(args[2]) ?? "",
        asHarnessString(args[3]),
      ];
    case "sendCommand":
      return [
        asHarnessString(args[0]) ?? "",
        asHarnessString(args[1]) ?? "",
        asHarnessString(args[2]) ?? "",
        args[3],
        args[4],
        args[5],
        asHarnessString(args[6]) ?? "",
        asHarnessString(args[7]),
      ];
    default:
      return args;
  }
}
