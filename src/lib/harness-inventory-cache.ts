/**
 * TTL cache for harness CLI inventories (workspace-agnostic). Avoids refetch on every model picker open.
 */

import type { OpenGuiClient } from "@/protocol/client";
import type { HarnessInventory } from "@/types/electron";

const DEFAULT_MAX_AGE_MS = 60_000;

let snapshot: { rows: HarnessInventory[]; fetchedAt: number } | null = null;
let inFlight: Promise<HarnessInventory[]> | null = null;

export function invalidateHarnessInventoryCache(): void {
  snapshot = null;
  inFlight = null;
}

export async function fetchHarnessInventoriesCached(
  client: OpenGuiClient,
  options?: { maxAgeMs?: number; force?: boolean },
): Promise<HarnessInventory[]> {
  const maxAgeMs = options?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = Date.now();

  if (!options?.force && snapshot && now - snapshot.fetchedAt < maxAgeMs) {
    return snapshot.rows;
  }

  if (!options?.force && inFlight) {
    return inFlight;
  }

  const promise = client.runtime
    .getHarnessInventories()
    .then((rows) => {
      snapshot = { rows, fetchedAt: Date.now() };
      return rows;
    })
    .catch(() => {
      const rows: HarnessInventory[] = [];
      snapshot = { rows, fetchedAt: Date.now() };
      return rows;
    })
    .finally(() => {
      if (inFlight === promise) {
        inFlight = null;
      }
    });

  inFlight = promise;
  return promise;
}

/** @internal Test-only */
export function resetHarnessInventoryCacheForTests(): void {
  snapshot = null;
  inFlight = null;
}
