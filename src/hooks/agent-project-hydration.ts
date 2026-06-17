import type { HarnessId } from "@/agents";

export interface ProjectHydrationState {
  desiredHarnessIds: HarnessId[];
  loadingHarnessIds: HarnessId[];
  completedHarnessIds: HarnessId[];
  failedHarnessIds: HarnessId[];
  errors: Partial<Record<HarnessId, string>>;
  lastStartedAt: number | null;
  lastSettledAt: number | null;
}

export interface BootstrapHydrationTask<T> {
  item: T;
  harnessId: HarnessId;
}

function uniqueHarnessIds(harnessIds: readonly HarnessId[]) {
  return Array.from(new Set(harnessIds));
}

function rotateHarnessIds(harnessIds: readonly HarnessId[], offset: number) {
  if (harnessIds.length === 0) return [];
  const normalizedOffset = ((offset % harnessIds.length) + harnessIds.length) % harnessIds.length;
  return [
    ...harnessIds.slice(normalizedOffset),
    ...harnessIds.slice(0, normalizedOffset),
  ] as HarnessId[];
}

function withoutHarnessIds(source: readonly HarnessId[], removed: Set<HarnessId>) {
  return source.filter((harnessId) => !removed.has(harnessId));
}

export function createEmptyProjectHydrationState(): ProjectHydrationState {
  return {
    desiredHarnessIds: [],
    loadingHarnessIds: [],
    completedHarnessIds: [],
    failedHarnessIds: [],
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
  const requested = uniqueHarnessIds(harnessIds);
  if (requested.length === 0) return existing;

  const completedSet = new Set(existing.completedHarnessIds);
  const retried = requested.filter((harnessId) => !completedSet.has(harnessId));
  const retriedSet = new Set(retried);
  const nextErrors = { ...existing.errors };
  for (const harnessId of retried) {
    delete nextErrors[harnessId];
  }

  return {
    desiredHarnessIds: uniqueHarnessIds([...existing.desiredHarnessIds, ...requested]),
    loadingHarnessIds: uniqueHarnessIds([...existing.loadingHarnessIds, ...retried]),
    completedHarnessIds: existing.completedHarnessIds,
    failedHarnessIds: withoutHarnessIds(existing.failedHarnessIds, retriedSet),
    errors: nextErrors,
    lastStartedAt: now,
    lastSettledAt: existing.lastSettledAt,
  };
}

export function settleProjectHydration(
  current: ProjectHydrationState | undefined,
  input: {
    completedHarnessIds?: readonly HarnessId[];
    failedBackends?: Partial<Record<HarnessId, string>>;
    now?: number;
  },
): ProjectHydrationState {
  const existing = current ?? createEmptyProjectHydrationState();
  const completedHarnessIds = uniqueHarnessIds(input.completedHarnessIds ?? []);
  const failedBackends = input.failedBackends ?? {};
  const failedHarnessIds = uniqueHarnessIds(Object.keys(failedBackends) as HarnessId[]);
  const settledSet = new Set<HarnessId>([...completedHarnessIds, ...failedHarnessIds]);
  const nextErrors = { ...existing.errors, ...failedBackends };
  for (const harnessId of completedHarnessIds) {
    delete nextErrors[harnessId];
  }

  return {
    desiredHarnessIds: uniqueHarnessIds([
      ...existing.desiredHarnessIds,
      ...completedHarnessIds,
      ...failedHarnessIds,
    ]),
    loadingHarnessIds: withoutHarnessIds(existing.loadingHarnessIds, settledSet),
    completedHarnessIds: uniqueHarnessIds([
      ...existing.completedHarnessIds,
      ...completedHarnessIds,
    ]),
    failedHarnessIds: uniqueHarnessIds([
      ...withoutHarnessIds(existing.failedHarnessIds, new Set(completedHarnessIds)),
      ...failedHarnessIds,
    ]),
    errors: nextErrors,
    lastStartedAt: existing.lastStartedAt,
    lastSettledAt: input.now ?? Date.now(),
  };
}

export function getPendingProjectHydrationHarnessIds(
  current: ProjectHydrationState | undefined,
  desiredHarnessIds: readonly HarnessId[],
) {
  const desired = uniqueHarnessIds(desiredHarnessIds);
  if (!current) return desired;
  const seen = new Set<HarnessId>([
    ...current.loadingHarnessIds,
    ...current.completedHarnessIds,
    ...current.failedHarnessIds,
  ]);
  return desired.filter((harnessId) => !seen.has(harnessId));
}

export function hasProjectHydrationInFlight(
  current: ProjectHydrationState | undefined,
  desiredHarnessIds: readonly HarnessId[],
) {
  if (!current) return false;
  const desired = new Set(uniqueHarnessIds(desiredHarnessIds));
  return current.loadingHarnessIds.some((harnessId) => desired.has(harnessId));
}

export function isProjectHydrationComplete(
  current: ProjectHydrationState | undefined,
  desiredHarnessIds: readonly HarnessId[],
) {
  const desired = uniqueHarnessIds(desiredHarnessIds);
  if (desired.length === 0) return true;
  if (!current) return false;
  const settled = new Set<HarnessId>([...current.completedHarnessIds, ...current.failedHarnessIds]);
  return desired.every((harnessId) => settled.has(harnessId));
}

export function buildBootstrapHydrationTasks<T>(input: {
  items: readonly T[];
  harnessIds: readonly HarnessId[];
  preferredHarnessId?: HarnessId;
}): Array<BootstrapHydrationTask<T>> {
  const baseHarnessIds = uniqueHarnessIds(input.harnessIds);
  const orderedHarnessIds = input.preferredHarnessId
    ? uniqueHarnessIds([input.preferredHarnessId, ...baseHarnessIds])
    : baseHarnessIds;
  const queues = input.items.map((item, index) => ({
    item,
    harnessIds: rotateHarnessIds(orderedHarnessIds, index),
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
