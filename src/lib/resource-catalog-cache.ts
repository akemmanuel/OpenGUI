/**
 * Canonical cache for harness resource catalogs (providers, agents, commands).
 * Key: harness + workspace + directory. Shared by agent routing and ModelSelector.
 */

import type { HarnessId } from "@/agents";
import type { HarnessResourceBundle } from "@/protocol/client";

export type CatalogTarget = {
  workspaceId: string;
  directory: string | null;
  baseUrl?: string;
  authToken?: string;
};

export function makeCatalogKey(input: {
  harnessId: HarnessId;
  workspaceId: string;
  directory: string | null | undefined;
  baseUrl?: string;
  authToken?: string;
}): string {
  const directory = input.directory?.trim() ?? "";
  const baseUrl = input.baseUrl?.trim() ?? "";
  const authToken = input.authToken ?? "";
  return [input.harnessId, input.workspaceId, directory, baseUrl, authToken].join("\u0000");
}

type LoadResourcesFn = (input: {
  harnessId: HarnessId;
  target: {
    directory?: string;
    workspaceId?: string;
    baseUrl?: string;
    authToken?: string;
  };
}) => Promise<HarnessResourceBundle>;

const catalogCache = new Map<string, HarnessResourceBundle>();
const inFlight = new Map<string, Promise<HarnessResourceBundle>>();

export function getCachedResourceBundle(catalogKey: string): HarnessResourceBundle | null {
  return catalogCache.get(catalogKey) ?? null;
}

export function getCachedProviders(catalogKey: string) {
  return catalogCache.get(catalogKey)?.providersData.providers ?? null;
}

export function setCachedResourceBundle(catalogKey: string, bundle: HarnessResourceBundle): void {
  catalogCache.set(catalogKey, bundle);
}

export function invalidateResourceCatalogCache(input?: {
  harnessId?: HarnessId;
  workspaceId?: string;
}): void {
  if (!input?.harnessId && !input?.workspaceId) {
    catalogCache.clear();
    return;
  }
  for (const key of catalogCache.keys()) {
    const [harnessId, workspaceId] = key.split("\u0000");
    if (input.harnessId && harnessId !== input.harnessId) continue;
    if (input.workspaceId && workspaceId !== input.workspaceId) continue;
    catalogCache.delete(key);
  }
}

export async function ensureResourceCatalog(input: {
  harnessId: HarnessId;
  target: CatalogTarget;
  loadResources: LoadResourcesFn;
  force?: boolean;
}): Promise<HarnessResourceBundle> {
  const catalogKey = makeCatalogKey({
    harnessId: input.harnessId,
    workspaceId: input.target.workspaceId,
    directory: input.target.directory,
    baseUrl: input.target.baseUrl,
    authToken: input.target.authToken,
  });

  if (!input.force) {
    const cached = catalogCache.get(catalogKey);
    if (cached) return cached;
    const pending = inFlight.get(catalogKey);
    if (pending) return pending;
  } else {
    catalogCache.delete(catalogKey);
    const pending = inFlight.get(catalogKey);
    if (pending) return pending;
  }

  const directory = input.target.directory?.trim() || undefined;
  const promise = input
    .loadResources({
      harnessId: input.harnessId,
      target: {
        directory,
        workspaceId: input.target.workspaceId,
        baseUrl: input.target.baseUrl,
        authToken: input.target.authToken,
      },
    })
    .then((bundle) => {
      catalogCache.set(catalogKey, bundle);
      return bundle;
    })
    .finally(() => {
      if (inFlight.get(catalogKey) === promise) {
        inFlight.delete(catalogKey);
      }
    });

  inFlight.set(catalogKey, promise);
  return promise;
}

/** @internal Test-only */
export function resetResourceCatalogCacheForTests(): void {
  catalogCache.clear();
  inFlight.clear();
}
