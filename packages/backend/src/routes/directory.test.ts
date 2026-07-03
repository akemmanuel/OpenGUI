import { describe, expect, test, vi } from "vite-plus/test";
import { handleDirectoryRequest } from "./directory.ts";
import { createMockApiRouteDeps } from "../test/mock-api-route-deps.ts";
import type { BackendServiceContext } from "../../../../server/services/index.ts";
import { asBackendServiceContext } from "../test/harness-test-mapping.ts";

const canonical = "/tmp/opengui-test-repo";
const encodedDir = encodeURIComponent(canonical);

type ApiJson = { ok: boolean; value?: unknown };

function directoryServices(overrides: Partial<BackendServiceContext["harnesses"]> = {}) {
  const registerDirectory = vi.fn(async () => ({
    connectedHarnessIds: ["pi"] as const,
    errors: [],
  }));
  const releaseDirectory = vi.fn(async () => undefined);
  const services = asBackendServiceContext({
    harnesses: {
      registerDirectory,
      releaseDirectory,
      getDirectoryStatus: vi.fn(async () => ({ connected: true, harnessId: "pi" })),
      loadResources: vi.fn(async () => ({
        providersData: { providers: [{ id: "p1", models: { m1: { name: "M1" } } }] },
        agentsData: { agents: [] },
        commandsData: { commands: [] },
      })),
      getManagedHarnessIds: () => ["pi"],
      ...overrides,
    },
  });
  return { services, registerDirectory, releaseDirectory };
}

describe("handleDirectoryRequest", () => {
  test("returns null outside /api/directories/", async () => {
    const deps = createMockApiRouteDeps();
    expect(
      await handleDirectoryRequest(new Request("http://127.0.0.1/api/sessions"), deps),
    ).toBeNull();
  });

  test("POST register calls registerDirectoryWithHarnesses", async () => {
    const { services, registerDirectory } = directoryServices();
    const deps = createMockApiRouteDeps({ services, canonicalDirectory: canonical });
    const response = await handleDirectoryRequest(
      new Request(`http://127.0.0.1/api/directories/${encodedDir}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ harnessIds: ["pi"], config: { directory: canonical } }),
      }),
      deps,
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as ApiJson;
    expect(body.ok).toBe(true);
    expect(registerDirectory).toHaveBeenCalled();
  });

  test("POST release calls releaseDirectory", async () => {
    const { services, releaseDirectory } = directoryServices();
    const deps = createMockApiRouteDeps({ services, canonicalDirectory: canonical });
    const response = await handleDirectoryRequest(
      new Request(`http://127.0.0.1/api/directories/${encodedDir}/release`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ harnessIds: ["pi"] }),
      }),
      deps,
    );
    expect(await response!.json()).toEqual({ ok: true, value: true });
    expect(releaseDirectory).toHaveBeenCalled();
  });

  test("GET status returns harness status", async () => {
    const { services } = directoryServices();
    const deps = createMockApiRouteDeps({ services, canonicalDirectory: canonical });
    const response = await handleDirectoryRequest(
      new Request(`http://127.0.0.1/api/directories/${encodedDir}/status?harnessId=pi`),
      deps,
    );
    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({ ok: true, value: { connected: true } });
  });

  test("GET providers requires harnessId", async () => {
    const deps = createMockApiRouteDeps({
      services: directoryServices().services,
      canonicalDirectory: canonical,
    });
    const response = await handleDirectoryRequest(
      new Request(`http://127.0.0.1/api/directories/${encodedDir}/providers`),
      deps,
    );
    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({ ok: false, error: "harnessId is required" });
  });

  test("GET models flattens provider models", async () => {
    const { services } = directoryServices();
    const deps = createMockApiRouteDeps({ services, canonicalDirectory: canonical });
    const response = await handleDirectoryRequest(
      new Request(`http://127.0.0.1/api/directories/${encodedDir}/models?harnessId=pi`),
      deps,
    );
    const body = (await response!.json()) as ApiJson;
    expect(body.ok).toBe(true);
    expect(body.value).toEqual([
      expect.objectContaining({ providerID: "p1", modelID: "m1", name: "M1" }),
    ]);
  });

  test("wrong method on register returns 405", async () => {
    const deps = createMockApiRouteDeps({ canonicalDirectory: canonical });
    const response = await handleDirectoryRequest(
      new Request(`http://127.0.0.1/api/directories/${encodedDir}/register`),
      deps,
    );
    expect(response?.status).toBe(405);
  });
});
