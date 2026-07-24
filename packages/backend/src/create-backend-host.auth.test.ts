import { afterEach, describe, expect, test } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackendHost } from "./create-backend-host.ts";
import type { BackendHostEnv } from "./host/env.ts";

const backends: ReturnType<typeof createBackendHost>[] = [];
const dataDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    backends.splice(0).map(async (backend) => {
      await (await backend.hostReady).close();
      backend.identity?.database.close();
    }),
  );
  for (const directory of dataDirectories.splice(0)) rmSync(directory, { recursive: true });
});

function backend(env: BackendHostEnv) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "opengui-backend-auth-"));
  dataDirectories.push(dataDirectory);
  const result = createBackendHost({
    dataDirectory,
    env,
    identityDatabase: new DatabaseSync(":memory:"),
    identitySecret: "test-secret-that-is-at-least-thirty-two-characters",
  });
  backends.push(result);
  return result;
}

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
    identityMode: "remote",
    ...overrides,
  };
}

describe("createBackendHost API auth and CORS", () => {
  test("/api/health is reachable without Authorization when auth is enabled", async () => {
    const { app } = backend(testEnv({ authToken: "required-secret" }));
    const response = await app.request("http://127.0.0.1/api/health");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, authRequired: true });
    expect(response.headers.get("access-control-allow-origin")).toBe("https://client.example");
  });

  test("/api/capabilities returns 401 without token when auth is enabled", async () => {
    const { app } = backend(testEnv({ authToken: "required-secret" }));
    const response = await app.request("http://127.0.0.1/api/capabilities");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "AUTH_REQUIRED" });
  });

  test("/api/capabilities succeeds with Bearer token", async () => {
    const { app } = backend(testEnv({ authToken: "required-secret" }));
    const response = await app.request("http://127.0.0.1/api/capabilities", {
      headers: { authorization: "Bearer required-secret" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  test("OPTIONS preflight returns 204 with CORS headers", async () => {
    const { app } = backend(testEnv({ authToken: "required-secret", allowedCorsOrigin: "*" }));
    const response = await app.request("http://127.0.0.1/api/sessions", { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("GET");
  });
});
