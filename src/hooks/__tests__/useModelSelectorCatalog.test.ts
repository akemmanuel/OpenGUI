import { describe, expect, test, vi, beforeEach } from "vite-plus/test";
import type { HarnessResourceBundle } from "@/protocol/client";
import {
  ensureResourceCatalog,
  getCachedResourceBundle,
  makeCatalogKey,
  resetResourceCatalogCacheForTests,
  subscribeResourceCatalogCache,
} from "@/lib/resource-catalog-cache";

const bundle = (): HarnessResourceBundle => ({
  providersData: {
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        source: "built-in",
        env: [],
        options: {},
        models: {
          m1: {
            id: "m1",
            name: "M1",
            provider: "anthropic",
            release_date: "",
            capabilities: { reasoning: false },
          },
        },
      },
    ],
    default: { anthropic: "m1" },
  },
  agentsData: [],
  commandsData: [],
});

describe("model selector catalog cache reactivity", () => {
  beforeEach(() => {
    resetResourceCatalogCacheForTests();
  });

  test("subscriber sees catalog after ensureResourceCatalog (useSyncExternalStore contract)", async () => {
    const listener = vi.fn();
    subscribeResourceCatalogCache(listener);
    const loadResources = vi.fn().mockResolvedValue(bundle());
    const target = { workspaceId: "local", directory: "/repo" };
    const key = makeCatalogKey({ harnessId: "pi", workspaceId: "local", directory: "/repo" });

    expect(getCachedResourceBundle(key)).toBeNull();
    await ensureResourceCatalog({ harnessId: "pi", target, loadResources });
    expect(getCachedResourceBundle(key)?.providersData.providers.length).toBeGreaterThan(0);
    expect(listener).toHaveBeenCalled();
  });
});
