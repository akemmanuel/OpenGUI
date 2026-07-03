import type { PiMessageBundle } from "./pi-bridge-mapping.ts";
import type {
  PiLiveSessionLike,
  PiLiveSessionRuntime,
  PiLiveState,
  PiModelRef,
  PiNativeSessionEvent,
  PiProjectTarget,
  PiSessionCache,
} from "./pi-bridge-types.ts";
import {
  makeHarnessProjectKey as makeProjectKey,
  normalizeHarnessDirectory as normalizeDir,
} from "./harness-adapter-kit.ts";

export type PiLiveSessionContext = {
  runtime: PiLiveSessionRuntime;
  session: PiLiveSessionLike;
  unsubscribe: (() => void) | null;
};

/** Result of resolving a live Pi session context (used by ensureSessionContext). */
export type PiSessionContextResolution = {
  project: PiBridgeProject;
  runtime: PiLiveSessionRuntime;
  session: PiLiveSessionLike;
  context: PiLiveSessionContext;
};

export type PiBridgeProject = {
  key: string;
  directory: string;
  workspaceId?: string;
  busySessionIds: Set<string>;
  abortedSessionIds: Set<string>;
  sessionCaches: Map<string, PiSessionCache>;
  liveStateBySessionId: Map<string, PiLiveState>;
  liveSessionContexts: Map<string, PiLiveSessionContext>;
  sessionContextInitPromises: Map<string, Promise<PiSessionContextResolution>>;
  runtime: PiLiveSessionContext["runtime"] | null;
  sessionUnsubscribe: (() => void) | null;
  currentSessionId: string | null;
  currentSessionFile: string | null;
};

export function createEmptyPiProjectShell(
  key: string,
  directory: string,
  workspaceId?: string,
): PiBridgeProject {
  return {
    key,
    directory,
    workspaceId,
    busySessionIds: new Set<string>(),
    abortedSessionIds: new Set<string>(),
    sessionCaches: new Map<string, PiSessionCache>(),
    liveStateBySessionId: new Map<string, PiLiveState>(),
    liveSessionContexts: new Map<string, PiLiveSessionContext>(),
    sessionContextInitPromises: new Map<string, Promise<PiSessionContextResolution>>(),
    runtime: null,
    sessionUnsubscribe: null,
    currentSessionId: null,
    currentSessionFile: null,
  };
}

export function resolvePiProjectKeyFromTarget(target: {
  directory?: string;
  workspaceId?: string;
}): { key: string; directory: string; workspaceId?: string } {
  const directory = normalizeDir(target.directory);
  if (!directory) throw new Error("Directory required for Pi backend");
  const workspaceId = target.workspaceId;
  return { key: makeProjectKey(workspaceId, directory), directory, workspaceId };
}

/** Registry-like object exposing a `projects` map (a PiBridgeManager or a stub). */
export type PiProjectRegistry = {
  projects: Map<string, PiBridgeProject>;
};

/**
 * Test helper: register an empty Pi project shell into a manager-like registry
 * without going through the async runtime init. Returns the inserted shell so
 * tests can mutate runtime maps (busySessionIds, sessionCaches, ...).
 */
export function registerPiBridgeProjectForTests(
  registry: PiProjectRegistry,
  target: PiProjectTarget,
): PiBridgeProject {
  const { key, directory, workspaceId } = resolvePiProjectKeyFromTarget(target);
  const project = createEmptyPiProjectShell(key, directory, workspaceId);
  registry.projects.set(key, project);
  return project;
}

export type { PiMessageBundle, PiNativeSessionEvent, PiModelRef };
