import { Hono } from "hono";
import { describe, expect, test, vi } from "vite-plus/test";
import { registerProductApiRoutes } from "./create-api-app.ts";
import { createMockApiRouteDeps } from "./test/mock-api-route-deps.ts";

type ApiJson = { ok: boolean; value?: unknown };

describe("registerProductApiRoutes", () => {
  function createTestApp() {
    const app = new Hono();
    const listDirectorySessions = vi.fn(async () => [
      {
        harnessId: "pi" as const,
        sessions: [],
      },
    ]);
    const deps = createMockApiRouteDeps({
      services: {
        harnesses: {
          getManagedHarnessIds: () => ["pi"],
          listDirectorySessions,
        },
      } as never,
    });
    registerProductApiRoutes(app, deps);
    return { app, listDirectorySessions };
  }

  test("GET /api/capabilities returns protocol capabilities", async () => {
    const { app } = createTestApp();
    const response = await app.request("http://127.0.0.1/api/capabilities");
    expect(response.status).toBe(200);
    const body = (await response.json()) as ApiJson;
    expect(body.ok).toBe(true);
    expect(body.value).toMatchObject({
      protocolVersion: 1,
      server: { sessions: true, events: "sse" },
    });
  });

  test("GET /api/version returns app version envelope", async () => {
    const { app } = createTestApp();
    const response = await app.request("http://127.0.0.1/api/version");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      value: { protocolVersion: 1 },
    });
  });

  test("GET /api/harnesses is dispatched through product handlers", async () => {
    const { app } = createTestApp();
    const response = await app.request("http://127.0.0.1/api/harnesses");
    expect(response.status).toBe(200);
    const body = (await response.json()) as ApiJson;
    expect(body.value).toEqual(expect.arrayContaining([expect.objectContaining({ id: "pi" })]));
  });

  test("GET /api/sessions uses session handler", async () => {
    const { app, listDirectorySessions } = createTestApp();
    const directory = encodeURIComponent("/tmp/opengui-test-repo");
    const response = await app.request(
      `http://127.0.0.1/api/sessions?directory=${directory}&harnessId=pi`,
    );
    expect(response.status).toBe(200);
    expect(listDirectorySessions).toHaveBeenCalled();
  });

  test("unmatched /api path returns 404 from host catch-all when registered after", async () => {
    const app = new Hono();
    registerProductApiRoutes(app, createMockApiRouteDeps());
    app.all("/api/*", () => new Response("Not found", { status: 404 }));
    const response = await app.request("http://127.0.0.1/api/no-such-route");
    expect(response.status).toBe(404);
  });
});
