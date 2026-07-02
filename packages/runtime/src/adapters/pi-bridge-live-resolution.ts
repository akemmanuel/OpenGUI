import type { PiMessageBundle } from "./pi-bridge-mapping.ts";

export interface PiPendingAssistantResolution {
  syntheticId: string;
  startedAt?: number;
}

export interface PiLiveAssistantState {
  currentAssistantMessageId?: string | null;
  syntheticToReal?: Map<string, string>;
  pendingAssistantResolutions?: PiPendingAssistantResolution[];
  assistantStartedAt?: number | null;
}

export interface PiProjectSessionCache {
  messages: PiMessageBundle[];
}

export interface PiProjectLike {
  sessionCaches: Map<string, PiProjectSessionCache>;
}

export interface PiSessionIndexEntry {
  projectKey: string;
  directory: string;
  workspaceId?: string;
}

export interface PiProjectRegistryLike {
  size: number;
  values(): IterableIterator<{
    key: string;
    directory: string;
    workspaceId?: string;
  }>;
  get(key: string):
    | {
        key: string;
        directory: string;
        workspaceId?: string;
      }
    | undefined;
}

export interface ResolvePiProjectContext {
  projects: PiProjectRegistryLike;
  sessionIndex: Map<string, PiSessionIndexEntry>;
  findLiveProjectKey(sessionId: string): string | undefined;
  ensureProject(target: {
    directory: string;
    workspaceId?: string;
  }): Promise<{ key: string; directory: string; workspaceId?: string }>;
}

export function resolveAssistantBundleCandidateIds(state: PiLiveAssistantState): string[] {
  const candidateIds: string[] = [];
  if (typeof state.currentAssistantMessageId === "string") {
    candidateIds.push(state.currentAssistantMessageId);
  }
  for (let i = 0; i < candidateIds.length; i += 1) {
    const id = candidateIds[i];
    const mapped = state.syntheticToReal?.get(id);
    if (mapped) candidateIds.push(mapped);
  }
  return candidateIds;
}

export function findCurrentAssistantBundleInCache(
  project: PiProjectLike,
  sessionId: string,
  state: PiLiveAssistantState,
): { messageId: string; bundle: PiMessageBundle } | null {
  const seen = new Set<string>();
  for (const id of resolveAssistantBundleCandidateIds(state)) {
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    const cache = project.sessionCaches.get(sessionId);
    const bundle = cache?.messages.find((item) => item.info.id === id) ?? null;
    if (bundle) return { messageId: id, bundle };
  }
  return null;
}

const PAIR_TIME_WINDOW_MS = 120_000;

export function pairPendingAssistantsWithCanonical(
  pendingStreaming: PiPendingAssistantResolution[],
  newCanonicalAssistants: PiMessageBundle[],
): Array<{ pending: PiPendingAssistantResolution; bundle: PiMessageBundle }> {
  const sortedPending = [...pendingStreaming].sort(
    (a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0),
  );
  const sortedNew = [...newCanonicalAssistants].sort(
    (a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0),
  );
  const usedCanonical = new Set<string>();
  const pairs: Array<{ pending: PiPendingAssistantResolution; bundle: PiMessageBundle }> = [];

  for (const pending of sortedPending) {
    const anchor = pending.startedAt ?? 0;
    let best: PiMessageBundle | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const bundle of sortedNew) {
      const id = bundle.info.id;
      if (usedCanonical.has(id)) continue;
      const created = bundle.info.time?.created ?? 0;
      const delta = Math.abs(created - anchor);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = bundle;
      }
    }
    if (best && bestDelta <= PAIR_TIME_WINDOW_MS) {
      usedCanonical.add(best.info.id);
      pairs.push({ pending, bundle: best });
    }
  }
  return pairs;
}

export async function resolvePiProjectForSession(
  ctx: ResolvePiProjectContext,
  sessionId: string,
  target: { directory?: string; workspaceId?: string } = {},
): Promise<{ key: string; directory: string; workspaceId?: string }> {
  const directory =
    typeof target.directory === "string" && target.directory.trim()
      ? target.directory.trim().replace(/\/+$/, "")
      : "";
  if (directory) {
    return ctx.ensureProject({ directory, workspaceId: target.workspaceId });
  }
  const liveKey = ctx.findLiveProjectKey(sessionId);
  if (liveKey) {
    const project = ctx.projects.get(liveKey);
    if (project) return project;
  }
  const indexed = ctx.sessionIndex.get(sessionId);
  if (indexed?.directory) {
    return ctx.ensureProject({
      directory: indexed.directory,
      workspaceId: indexed.workspaceId,
    });
  }
  if (ctx.projects.size === 1) {
    return ctx.projects.values().next().value as {
      key: string;
      directory: string;
      workspaceId?: string;
    };
  }
  throw new Error("Pi operation requires a Project directory");
}
