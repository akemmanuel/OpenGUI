import { describe, expect, test } from "vite-plus/test";
import { createBackendHost } from "./create-backend-host.ts";
import type { BackendHostEnv } from "./host/env.ts";

function testEnv(overrides: Partial<BackendHostEnv>): BackendHostEnv {
  return {
    port: 0,
    hostname: "127.0.0.1",
    isProduction: true,
    serverMode: "api-only",
    servesFrontend: false,
    authToken: "",
    allowedCorsOrigin: "https://client.example",
    allowedRoots: ["/tmp"],
    uploadMaxFileBytes: 1024,
    uploadMaxBatchBytes: 2048,
    ...overrides,
  };
}

describe("createBackendHost API auth and CORS", () => {
  test("/api/health is reachable without Authorization when auth is enabled", async () => {
    const { app } = createBackendHost({
      env: testEnv({ authToken: "required-secret" }),
    });
    const response = await app.request("http://127.0.0.1/api/health");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, authRequired: true });
    expect(response.headers.get("access-control-allow-origin")).toBe("https://client.example");
  });

  test("/api/capabilities returns 401 without token when auth is enabled", async () => {
    const { app } = createBackendHost({
      env: testEnv({ authToken: "required-secret" }),
    });
    const response = await app.request("http://127.0.0.1/api/capabilities");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "AUTH_REQUIRED" });
  });

  test("/api/capabilities succeeds with Bearer token", async () => {
    const { app } = createBackendHost({
      env: testEnv({ authToken: "required-secret" }),
    });
    const response = await app.request("http://127.0.0.1/api/capabilities", {
      headers: { authorization: "Bearer required-secret" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  test("OPTIONS preflight returns 204 with CORS headers", async () => {
    const { app } = createBackendHost({
      env: testEnv({ authToken: "required-secret", allowedCorsOrigin: "*" }),
    });
    const response = await app.request("http://127.0.0.1/api/sessions", { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("GET");
  });
});
