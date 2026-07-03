import { describe, expect, test, vi, beforeEach } from "vite-plus/test";
import type { HarnessId } from "@/agents";
import type { HarnessResourceBundle } from "@/protocol/client";
import { ensureHarnessResourceCatalog } from "@/lib/ensure-harness-resource-catalog";
import { resetResourceCatalogCacheForTests } from "@/lib/resource-catalog-cache";

const loadResources = vi.fn();

vi.mock("@/protocol/provider", () => ({
  useOpenGuiClient: () => ({
    harnesses: {
      loadResources,
    },
  }),
}));

const bundle = (): HarnessResourceBundle => ({
  providersData: { providers: [], default: {} },
  agentsData: [],
  commandsData: [],
});

describe("ModelSelector catalog cache", () => {
  beforeEach(() => {
    resetResourceCatalogCacheForTests();
    loadResources.mockReset();
    loadResources.mockResolvedValue(bundle());
  });

  test("ensureHarnessResourceCatalog uses one loadResources call for the same catalog key", async () => {
    const harnessId = "pi" as HarnessId;
    const target = { workspaceId: "local", directory: "/repo" };
    const client = { harnesses: { loadResources } } as never;

    await ensureHarnessResourceCatalog({ harnessId, target, client });
    await ensureHarnessResourceCatalog({ harnessId, target, client });

    expect(loadResources).toHaveBeenCalledTimes(1);
  });
});
