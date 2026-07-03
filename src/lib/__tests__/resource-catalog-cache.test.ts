import { describe, expect, test, vi } from "vite-plus/test";
import type { HarnessResourceBundle } from "@/protocol/client";
import {
  ensureResourceCatalog,
  getCachedResourceBundle,
  invalidateResourceCatalogCache,
  isCatalogKeyPending,
  makeCatalogKey,
  resetResourceCatalogCacheForTests,
  subscribeResourceCatalogCache,
} from "../resource-catalog-cache";

const bundle = (): HarnessResourceBundle => ({
  providersData: { providers: [], default: {} },
  agentsData: [],
  commandsData: [],
});

describe("makeCatalogKey", () => {
  test("normalizes null directory to empty segment", () => {
    const a = makeCatalogKey({ harnessId: "pi", workspaceId: "local", directory: null });
    const b = makeCatalogKey({ harnessId: "pi", workspaceId: "local", directory: undefined });
    expect(a).toBe(b);
    expect(a).toBe(["pi", "local", "", "", ""].join("\u0000"));
  });

  test("different baseUrl or authToken produce different keys", () => {
    const base = {
      harnessId: "pi" as const,
      workspaceId: "remote",
      directory: "/repo",
    };
    const a = makeCatalogKey({ ...base, baseUrl: "https://a.example", authToken: "t1" });
    const b = makeCatalogKey({ ...base, baseUrl: "https://b.example", authToken: "t1" });
    const c = makeCatalogKey({ ...base, baseUrl: "https://a.example", authToken: "t2" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("ensureResourceCatalog", () => {
  test("cache hit avoids loadResources", async () => {
    resetResourceCatalogCacheForTests();
    const loadResources = vi.fn().mockResolvedValue(bundle());
    const target = { workspaceId: "local", directory: "/repo" };

    await ensureResourceCatalog({
      harnessId: "pi",
      target,
      loadResources,
    });
    expect(loadResources).toHaveBeenCalledTimes(1);

    await ensureResourceCatalog({
      harnessId: "pi",
      target,
      loadResources,
    });
    expect(loadResources).toHaveBeenCalledTimes(1);
  });

  test("in-flight coalesces to one RPC", async () => {
    resetResourceCatalogCacheForTests();
    let resolve!: (b: HarnessResourceBundle) => void;
    const loadResources = vi.fn(
      () =>
        new Promise<HarnessResourceBundle>((res) => {
          resolve = res;
        }),
    );
    const target = { workspaceId: "local", directory: "/repo" };

    const key = makeCatalogKey({ harnessId: "pi", workspaceId: "local", directory: "/repo" });
    const p1 = ensureResourceCatalog({ harnessId: "pi", target, loadResources });
    const p2 = ensureResourceCatalog({ harnessId: "pi", target, loadResources });
    expect(loadResources).toHaveBeenCalledTimes(1);
    expect(isCatalogKeyPending(key)).toBe(true);

    resolve(bundle());
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
    expect(isCatalogKeyPending(key)).toBe(false);
  });

  test("force refresh calls loadResources again", async () => {
    resetResourceCatalogCacheForTests();
    const loadResources = vi.fn().mockResolvedValueOnce(bundle()).mockResolvedValueOnce(bundle());
    const target = { workspaceId: "local", directory: "/repo" };

    await ensureResourceCatalog({ harnessId: "pi", target, loadResources });
    await ensureResourceCatalog({ harnessId: "pi", target, loadResources, force: true });
    expect(loadResources).toHaveBeenCalledTimes(2);
  });

  test("invalidate by harnessId drops matching keys", async () => {
    resetResourceCatalogCacheForTests();
    const loadResources = vi.fn().mockResolvedValue(bundle());
    const target = { workspaceId: "local", directory: "/repo" };
    const key = makeCatalogKey({
      harnessId: "pi",
      workspaceId: "local",
      directory: "/repo",
    });

    await ensureResourceCatalog({ harnessId: "pi", target, loadResources });
    expect(getCachedResourceBundle(key)).not.toBeNull();

    invalidateResourceCatalogCache({ harnessId: "pi" });
    expect(getCachedResourceBundle(key)).toBeNull();
  });

  test("subscribe fires when catalog is stored", async () => {
    resetResourceCatalogCacheForTests();
    const listener = vi.fn();
    const unsub = subscribeResourceCatalogCache(listener);
    const loadResources = vi.fn().mockResolvedValue(bundle());
    const target = { workspaceId: "local", directory: "/repo" };

    await ensureResourceCatalog({ harnessId: "pi", target, loadResources });
    expect(listener).toHaveBeenCalled();
    unsub();
  });

  test("pi with null directory and empty providers is not cached", async () => {
    resetResourceCatalogCacheForTests();
    const loadResources = vi.fn().mockResolvedValue(bundle());
    const target = { workspaceId: "local", directory: null };
    const key = makeCatalogKey({ harnessId: "pi", workspaceId: "local", directory: null });

    await ensureResourceCatalog({ harnessId: "pi", target, loadResources });
    expect(loadResources).toHaveBeenCalledTimes(1);
    expect(getCachedResourceBundle(key)).toBeNull();
  });
});
