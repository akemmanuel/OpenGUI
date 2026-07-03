import { describe, expect, test, vi } from "vite-plus/test";
import { piHarnessProvidersCatalog } from "../pi-providers.ts";

describe("piHarnessProvidersCatalog", () => {
  test("reloads auth, refreshes registry, and returns full catalog shape", () => {
    const reload = vi.fn();
    const refresh = vi.fn();
    const model = {
      id: "m1",
      provider: "anthropic",
      name: "Model One",
      input: ["text"],
    };
    const registry = {
      refresh,
      getAll: () => [model],
      authStorage: { reload, hasAuth: () => true, get: () => ({ type: "api_key" }) },
      getProviderDisplayName: (id: string) => id,
      getProviderAuthStatus: () => ({ configured: true, source: "stored" as const }),
    };

    const result = piHarnessProvidersCatalog(registry);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalled();
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]?.id).toBe("anthropic");
    expect(result.providers[0]?.models.m1?.id).toBe("m1");
    expect(result.default.anthropic).toBe("m1");
  });

  test("returns full getAll catalog when getAvailable would be empty", () => {
    const models = [
      { id: "a1", provider: "anthropic", name: "A", input: ["text"] },
      { id: "o1", provider: "openrouter", name: "O", input: ["text"] },
    ];
    const registry = {
      refresh: vi.fn(),
      getAll: () => models,
      authStorage: { reload: vi.fn(), hasAuth: () => false },
      getProviderDisplayName: (id: string) => id,
      getProviderAuthStatus: () => ({ configured: false, source: "none" as const }),
    };

    const result = piHarnessProvidersCatalog(registry);

    expect(result.providers.length).toBeGreaterThanOrEqual(2);
    expect(result.providers.some((p) => p.id === "openrouter")).toBe(true);
  });
});
