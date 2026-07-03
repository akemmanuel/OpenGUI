import type { PiMessageBundle } from "./pi-bridge-mapping.ts";
import type {
  PiLiveSessionLike,
  PiLiveState,
  PiModelRef,
  PiNativeSessionEvent,
  PiSessionCache,
} from "./pi-bridge-types.ts";

import {
  makeHarnessProjectKey as makeProjectKey,
  normalizeHarnessDirectory as normalizeDir,
} from "./harness-adapter-kit.ts";

export type PiEnsureSessionContextResult = {
  project: PiBridgeProject;
  runtime: PiLiveSessionContext["runtime"];
  session: PiLiveSessionLike;
  context: PiLiveSessionContext;
};

export type PiAgentRuntimeServices = {
  modelRegistry?: {
    refresh?: () => void;
    getAll?: () => unknown[];
    getAvailable: () => unknown[];
    authStorage?: { reload?: () => void };
  };
};

export type PiLiveSessionContext = {
  runtime: {
    session: PiLiveSessionLike;
    dispose: () => Promise<void>;
    services?: PiAgentRuntimeServices;
  };
  session: PiLiveSessionLike;
  unsubscribe: (() => void) | null;
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
  sessionContextInitPromises: Map<
    string,
    Promise<{
      project: PiBridgeProject;
      runtime: PiLiveSessionContext["runtime"];
      session: PiLiveSessionLike;
      context: PiLiveSessionContext;
    }>
  >;
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
    sessionContextInitPromises: new Map(),
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

/** Minimal registry surface for unit tests (PiBridgeManager.projects). */
export type PiBridgeProjectRegistry = {
  projects: Map<string, PiBridgeProject>;
};

/** Register a disconnected project shell without spinning up Pi runtime. */
export function registerPiBridgeProjectForTests(
  registry: PiBridgeProjectRegistry,
  target: { directory?: string; workspaceId?: string } = { directory: "/repo" },
): PiBridgeProject {
  const { key, directory, workspaceId } = resolvePiProjectKeyFromTarget(target);
  const project = createEmptyPiProjectShell(key, directory, workspaceId);
  registry.projects.set(key, project);
  return project;
}

export type { PiMessageBundle, PiNativeSessionEvent, PiModelRef };
