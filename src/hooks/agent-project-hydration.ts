import type { AgentBackendId } from "@/agents";

export interface ProjectHydrationState {
  desiredBackendIds: AgentBackendId[];
  loadingBackendIds: AgentBackendId[];
  completedBackendIds: AgentBackendId[];
  failedBackendIds: AgentBackendId[];
  errors: Partial<Record<AgentBackendId, string>>;
  lastStartedAt: number | null;
  lastSettledAt: number | null;
}

export interface BootstrapHydrationTask<T> {
  item: T;
  backendId: AgentBackendId;
}

function uniqueBackendIds(backendIds: readonly AgentBackendId[]) {
  return Array.from(new Set(backendIds));
}

function rotateBackendIds(backendIds: readonly AgentBackendId[], offset: number) {
  if (backendIds.length === 0) return [];
  const normalizedOffset = ((offset % backendIds.length) + backendIds.length) % backendIds.length;
  return [
    ...backendIds.slice(normalizedOffset),
    ...backendIds.slice(0, normalizedOffset),
  ] as AgentBackendId[];
}

function withoutBackendIds(source: readonly AgentBackendId[], removed: Set<AgentBackendId>) {
  return source.filter((backendId) => !removed.has(backendId));
}

export function createEmptyProjectHydrationState(): ProjectHydrationState {
  return {
    desiredBackendIds: [],
    loadingBackendIds: [],
    completedBackendIds: [],
    failedBackendIds: [],
    errors: {},
    lastStartedAt: null,
    lastSettledAt: null,
  };
}

export function startProjectHydration(
  current: ProjectHydrationState | undefined,
  backendIds: readonly AgentBackendId[],
  now = Date.now(),
): ProjectHydrationState {
  const existing = current ?? createEmptyProjectHydrationState();
  const requested = uniqueBackendIds(backendIds);
  if (requested.length === 0) return existing;

  const completedSet = new Set(existing.completedBackendIds);
  const retried = requested.filter((backendId) => !completedSet.has(backendId));
  const retriedSet = new Set(retried);
  const nextErrors = { ...existing.errors };
  for (const backendId of retried) {
    delete nextErrors[backendId];
  }

  return {
    desiredBackendIds: uniqueBackendIds([...existing.desiredBackendIds, ...requested]),
    loadingBackendIds: uniqueBackendIds([...existing.loadingBackendIds, ...retried]),
    completedBackendIds: existing.completedBackendIds,
    failedBackendIds: withoutBackendIds(existing.failedBackendIds, retriedSet),
    errors: nextErrors,
    lastStartedAt: now,
    lastSettledAt: existing.lastSettledAt,
  };
}

export function settleProjectHydration(
  current: ProjectHydrationState | undefined,
  input: {
    completedBackendIds?: readonly AgentBackendId[];
    failedBackends?: Partial<Record<AgentBackendId, string>>;
    now?: number;
  },
): ProjectHydrationState {
  const existing = current ?? createEmptyProjectHydrationState();
  const completedBackendIds = uniqueBackendIds(input.completedBackendIds ?? []);
  const failedBackends = input.failedBackends ?? {};
  const failedBackendIds = uniqueBackendIds(Object.keys(failedBackends) as AgentBackendId[]);
  const settledSet = new Set<AgentBackendId>([...completedBackendIds, ...failedBackendIds]);
  const nextErrors = { ...existing.errors, ...failedBackends };
  for (const backendId of completedBackendIds) {
    delete nextErrors[backendId];
  }

  return {
    desiredBackendIds: uniqueBackendIds([
      ...existing.desiredBackendIds,
      ...completedBackendIds,
      ...failedBackendIds,
    ]),
    loadingBackendIds: withoutBackendIds(existing.loadingBackendIds, settledSet),
    completedBackendIds: uniqueBackendIds([
      ...existing.completedBackendIds,
      ...completedBackendIds,
    ]),
    failedBackendIds: uniqueBackendIds([
      ...withoutBackendIds(existing.failedBackendIds, new Set(completedBackendIds)),
      ...failedBackendIds,
    ]),
    errors: nextErrors,
    lastStartedAt: existing.lastStartedAt,
    lastSettledAt: input.now ?? Date.now(),
  };
}

export function getPendingProjectHydrationBackendIds(
  current: ProjectHydrationState | undefined,
  desiredBackendIds: readonly AgentBackendId[],
) {
  const desired = uniqueBackendIds(desiredBackendIds);
  if (!current) return desired;
  const seen = new Set<AgentBackendId>([
    ...current.loadingBackendIds,
    ...current.completedBackendIds,
    ...current.failedBackendIds,
  ]);
  return desired.filter((backendId) => !seen.has(backendId));
}

export function hasProjectHydrationInFlight(
  current: ProjectHydrationState | undefined,
  desiredBackendIds: readonly AgentBackendId[],
) {
  if (!current) return false;
  const desired = new Set(uniqueBackendIds(desiredBackendIds));
  return current.loadingBackendIds.some((backendId) => desired.has(backendId));
}

export function isProjectHydrationComplete(
  current: ProjectHydrationState | undefined,
  desiredBackendIds: readonly AgentBackendId[],
) {
  const desired = uniqueBackendIds(desiredBackendIds);
  if (desired.length === 0) return true;
  if (!current) return false;
  const settled = new Set<AgentBackendId>([
    ...current.completedBackendIds,
    ...current.failedBackendIds,
  ]);
  return desired.every((backendId) => settled.has(backendId));
}

export function buildBootstrapHydrationTasks<T>(input: {
  items: readonly T[];
  backendIds: readonly AgentBackendId[];
  preferredBackendId?: AgentBackendId;
}): Array<BootstrapHydrationTask<T>> {
  const baseBackendIds = uniqueBackendIds(input.backendIds);
  const orderedBackendIds = input.preferredBackendId
    ? uniqueBackendIds([input.preferredBackendId, ...baseBackendIds])
    : baseBackendIds;
  const queues = input.items.map((item, index) => ({
    item,
    backendIds: rotateBackendIds(orderedBackendIds, index),
  }));
  const tasks: Array<BootstrapHydrationTask<T>> = [];

  let added = true;
  while (added) {
    added = false;
    for (const queue of queues) {
      const backendId = queue.backendIds.shift();
      if (!backendId) continue;
      tasks.push({ item: queue.item, backendId });
      added = true;
    }
  }

  return tasks;
}

export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
) {
  const limit = Math.max(1, Math.floor(concurrency) || 1);
  let nextIndex = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) return;
      await worker(item, index);
    }
  });

  await Promise.all(runners);
}
