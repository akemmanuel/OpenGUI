/** IPC argument narrowing for Pi harness RPC handlers. */

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

export function parsePiSessionCreateInput(
  title: unknown,
  directory: unknown,
  workspaceId: unknown,
): { title?: string; directory?: string; workspaceId?: string } {
  return {
    title: asHarnessString(title),
    directory: asHarnessString(directory),
    workspaceId: asHarnessString(workspaceId),
  };
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