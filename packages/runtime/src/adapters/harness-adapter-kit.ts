import { normalize } from "node:path";

export const DEFAULT_HARNESS_STATUS = {
  state: "idle",
  serverUrl: null,
  serverVersion: null,
  error: null,
  lastEventAt: null,
};

export function normalizeHarnessDirectory(directory: unknown) {
  if (typeof directory !== "string") return "";
  const trimmed = directory.trim();
  if (!trimmed) return "";
  return normalize(trimmed);
}

export function makeHarnessProjectKey(workspaceId: unknown, directory: unknown) {
  const workspaceKey = typeof workspaceId === "string" && workspaceId ? workspaceId : "local";
  return `${workspaceKey}:${normalizeHarnessDirectory(directory)}`;
}

export function makeHarnessSessionIdCodec(prefix: string) {
  const normalizedPrefix = prefix.endsWith(":") ? prefix : `${prefix}:`;
  const coerce = (id: unknown) => {
    if (typeof id === "string") return id;
    if (typeof id === "number" || typeof id === "boolean" || typeof id === "bigint") {
      return String(id);
    }
    return "";
  };
  return {
    toFrontendSessionId: (id: unknown) => {
      const raw = coerce(id);
      return raw.startsWith(normalizedPrefix) ? raw : `${normalizedPrefix}${raw}`;
    },
    toRawSessionId: (id: unknown) => {
      const raw = coerce(id);
      return raw.startsWith(normalizedPrefix) ? raw.slice(normalizedPrefix.length) : raw;
    },
  };
}

export function ok<T>(data: T) {
  return { success: true, data };
}

export function fail(error: unknown, data?: unknown) {
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
    data,
  };
}

export function nowHarnessConnection(status: Record<string, unknown> = {}) {
  return {
    ...DEFAULT_HARNESS_STATUS,
    ...status,
    lastEventAt: Date.now(),
  };
}
