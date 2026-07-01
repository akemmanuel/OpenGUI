import type { HarnessId } from "@/agents";
import type { HarnessResourceBundle, OpenGuiClient } from "@/protocol/client";
import {
  ensureResourceCatalog,
  getCachedResourceBundle,
  makeCatalogKey,
  type CatalogTarget,
} from "@/lib/resource-catalog-cache";

export type EnsureHarnessCatalogTarget = CatalogTarget;

export async function ensureHarnessResourceCatalog(input: {
  harnessId: HarnessId;
  target: EnsureHarnessCatalogTarget;
  client: OpenGuiClient;
  force?: boolean;
}): Promise<HarnessResourceBundle> {
  const key = makeCatalogKey({
    harnessId: input.harnessId,
    workspaceId: input.target.workspaceId,
    directory: input.target.directory,
    baseUrl: input.target.baseUrl,
    authToken: input.target.authToken,
  });
  if (!input.force) {
    const cached = getCachedResourceBundle(key);
    if (cached) return cached;
  }
  return ensureResourceCatalog({
    harnessId: input.harnessId,
    target: input.target,
    loadResources: input.client.harnesses.loadResources.bind(input.client.harnesses),
    force: input.force,
  });
}
