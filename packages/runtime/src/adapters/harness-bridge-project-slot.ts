/**
 * Shared project-directory slots for harness bridge managers (Codex, Grok, etc.).
 * Pi uses the richer PiBridgeProject in pi-project-slot.ts.
 */

import {
  makeHarnessProjectKey as makeProjectKey,
  normalizeHarnessDirectory as normalizeDir,
} from "./harness-adapter-kit.ts";

export type HarnessProjectTarget = { directory?: string; workspaceId?: string };

export type HarnessProjectSlot = {
  key: string;
  directory: string;
  workspaceId?: string;
};

export function resolveHarnessProjectKey(target: HarnessProjectTarget): {
  key: string;
  directory: string;
  workspaceId?: string;
} {
  const directory = normalizeDir(target.directory);
  if (!directory) {
    throw new Error("Project directory is required");
  }
  const workspaceId = target.workspaceId;
  return { key: makeProjectKey(workspaceId, directory), directory, workspaceId };
}

export function createHarnessProjectSlot(
  key: string,
  directory: string,
  workspaceId?: string,
): HarnessProjectSlot {
  return { key, directory, workspaceId };
}

/** Get or insert a minimal project slot in a manager's projects map. */
export function ensureHarnessProjectSlot<T extends HarnessProjectSlot>(
  projects: Map<string, T>,
  target: HarnessProjectTarget,
  create: (key: string, directory: string, workspaceId?: string) => T,
  options?: { directoryRequiredMessage?: string },
): T {
  const directory = normalizeDir(target.directory);
  if (!directory) {
    throw new Error(options?.directoryRequiredMessage ?? "Project directory is required");
  }
  const workspaceId = target.workspaceId;
  const key = makeProjectKey(workspaceId, directory);
  let project = projects.get(key);
  if (!project) {
    project = create(key, directory, workspaceId);
    projects.set(key, project);
  }
  return project;
}
