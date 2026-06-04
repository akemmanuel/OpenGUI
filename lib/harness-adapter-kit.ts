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
