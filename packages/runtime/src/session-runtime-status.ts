import type { HarnessId } from "../../../src/agents/index.ts";

export type SessionRuntimeStatus = "idle" | "running" | "error" | "unknown";

export function sessionStatusKey(directory: string, harnessId: HarnessId, rawId: string) {
  return `${directory}::${harnessId}::${rawId}`;
}

export function mapHarnessSessionStatus(type: string | undefined): SessionRuntimeStatus {
  if (type === "busy" || type === "running") return "running";
  if (type === "idle") return "idle";
  if (type === "error") return "error";
  return "unknown";
}

/** Update status for a raw session id across all known directory keys, or seed registered directories. */
export function updateSessionStatusMap(input: {
  map: Map<string, SessionRuntimeStatus>;
  harnessId: HarnessId;
  rawId: string;
  status: SessionRuntimeStatus;
  registeredDirectories: ReadonlySet<string>;
  directoryPath?: string;
}): void {
  const { map, harnessId, rawId, status, registeredDirectories, directoryPath } = input;
  const suffix = `::${harnessId}::${rawId}`;
  let updated = false;
  for (const key of map.keys()) {
    if (key.endsWith(suffix)) {
      map.set(key, status);
      updated = true;
    }
  }
  if (updated) return;
  const directories = new Set(registeredDirectories);
  if (directoryPath) directories.add(directoryPath);
  for (const directory of directories) {
    map.set(sessionStatusKey(directory, harnessId, rawId), status);
  }
}
