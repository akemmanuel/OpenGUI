import type { HarnessId } from "@/agents";

export interface ProjectHydrationState {
  desiredBackendIds: HarnessId[];
  loadingBackendIds: HarnessId[];
  completedBackendIds: HarnessId[];
  failedBackendIds: HarnessId[];
  errors: Partial<Record<HarnessId, string>>;
  lastStartedAt: number | null;
  lastSettledAt: number | null;
}

export interface BootstrapHydrationTask<T> {
  item: T;
  harnessId: HarnessId;
}

function uniqueBackendIds(harnessIds: readonly HarnessId[]) {
  return Array.from(new Set(harnessIds));
}

function rotateBackendIds(harnessIds: readonly HarnessId[], offset: number) {
  if (harnessIds.length === 0) return [];
  const normalizedOffset = ((offset % harnessIds.length) + harnessIds.length) % harnessIds.length;
  return [
    ...harnessIds.slice(normalizedOffset),
    ...harnessIds.slice(0, normalizedOffset),
  ] as HarnessId[];
}

function withoutBackendIds(source: readonly HarnessId[], removed: Set<HarnessId>) {
  return source.filter((harnessId) => !removed.has(harnessId));
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
  harnessIds: readonly HarnessId[],
  now = Date.now(),
): ProjectHydrationState {
  const existing = current ?? createEmptyProjectHydrationState();
  const requested = uniqueBackendIds(harnessIds);
  if (requested.length === 0) return existing;

  const completedSet = new Set(existing.completedBackendIds);
  const retried = requested.filter((harnessId) => !completedSet.has(harnessId));
  const retriedSet = new Set(retried);
  const nextErrors = { ...existing.errors };
  for (const harnessId of retried) {
    delete nextErrors[harnessId];
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
    completedBackendIds?: readonly HarnessId[];
    failedBackends?: Partial<Record<HarnessId, string>>;
    now?: number;
  },
): ProjectHydrationState {
  const existing = current ?? createEmptyProjectHydrationState();
  const completedBackendIds = uniqueBackendIds(input.completedBackendIds ?? []);
  const failedBackends = input.failedBackends ?? {};
  const failedBackendIds = uniqueBackendIds(Object.keys(failedBackends) as HarnessId[]);
  const settledSet = new Set<HarnessId>([...completedBackendIds, ...failedBackendIds]);
  const nextErrors = { ...existing.errors, ...failedBackends };
  for (const harnessId of completedBackendIds) {
    delete nextErrors[harnessId];
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
  desiredBackendIds: readonly HarnessId[],
) {
  const desired = uniqueBackendIds(desiredBackendIds);
  if (!current) return desired;
  const seen = new Set<HarnessId>([
    ...current.loadingBackendIds,
    ...current.completedBackendIds,
    ...current.failedBackendIds,
  ]);
  return desired.filter((harnessId) => !seen.has(harnessId));
}

export function hasProjectHydrationInFlight(
  current: ProjectHydrationState | undefined,
  desiredBackendIds: readonly HarnessId[],
) {
  if (!current) return false;
  const desired = new Set(uniqueBackendIds(desiredBackendIds));
  return current.loadingBackendIds.some((harnessId) => desired.has(harnessId));
}

export function isProjectHydrationComplete(
  current: ProjectHydrationState | undefined,
  desiredBackendIds: readonly HarnessId[],
) {
  const desired = uniqueBackendIds(desiredBackendIds);
  if (desired.length === 0) return true;
  if (!current) return false;
  const settled = new Set<HarnessId>([...current.completedBackendIds, ...current.failedBackendIds]);
  return desired.every((harnessId) => settled.has(harnessId));
}

export function buildBootstrapHydrationTasks<T>(input: {
  items: readonly T[];
  harnessIds: readonly HarnessId[];
  preferredBackendId?: HarnessId;
}): Array<BootstrapHydrationTask<T>> {
  const baseBackendIds = uniqueBackendIds(input.harnessIds);
  const orderedBackendIds = input.preferredBackendId
    ? uniqueBackendIds([input.preferredBackendId, ...baseBackendIds])
    : baseBackendIds;
  const queues = input.items.map((item, index) => ({
    item,
    harnessIds: rotateBackendIds(orderedBackendIds, index),
  }));
  const tasks: Array<BootstrapHydrationTask<T>> = [];

  let added = true;
  while (added) {
    added = false;
    for (const queue of queues) {
      const harnessId = queue.harnessIds.shift();
      if (!harnessId) continue;
      tasks.push({ item: queue.item, harnessId });
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
