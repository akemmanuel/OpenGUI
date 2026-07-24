import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createBackendHost, type BackendHost } from "./create-backend-host.ts";
import type { BackendHostEnv } from "./host/env.ts";

const backends: BackendHost[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    backends.splice(0).map(async (backend) => {
      await (await backend.hostReady).close();
      backend.identity?.database.close();
    }),
  );
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function backend() {
  const root = await mkdtemp(join(tmpdir(), "opengui-auth-matrix-"));
  temporaryDirectories.push(root);
  const previousDataDirectory = process.env.OPENGUI_DATA_DIR;
  process.env.OPENGUI_DATA_DIR = join(root, "data");
  const env: BackendHostEnv = {
    port: 0,
    hostname: "127.0.0.1",
    isProduction: true,
    serverMode: "api-only",
    servesFrontend: false,
    authToken: "legacy-bootstrap-token",
    allowedCorsOrigin: "https://client.example",
    allowedRoots: [root],
    uploadMaxFileBytes: 1024,
    uploadMaxBatchBytes: 2048,
    identityMode: "remote",
    pathGrantsMode: "disabled",
  };
  const result = createBackendHost({
    env,
    identityDatabase: new DatabaseSync(":memory:"),
    identitySecret: "auth-matrix-secret-with-at-least-thirty-two-characters",
    identityBaseURL: "http://localhost",
  });
  if (previousDataDirectory === undefined) delete process.env.OPENGUI_DATA_DIR;
  else process.env.OPENGUI_DATA_DIR = previousDataDirectory;
  backends.push(result);
  await result.ready;
  return result;
}

describe("Remote Host authentication matrix", () => {
  test("keeps health and identity entry points public while protecting every product surface", async () => {
    const { app } = await backend();

    for (const path of ["/api/health", "/api/host/health", "/api/identity/policy"]) {
      expect((await app.request(`http://localhost${path}`)).status, path).toBe(200);
    }

    const protectedRequests: Array<[string, RequestInit?]> = [
      ["/api/capabilities"],
      ["/api/version"],
      ["/api/rpc", { method: "POST", body: "{}" }],
      ["/api/fs/roots"],
      ["/api/host/models"],
      ["/api/host/projects"],
      ["/api/host/sessions?directory=%2Ftmp"],
      ["/api/host/events"],
      ["/api/identity/me"],
      ["/api/identity/members"],
    ];
    for (const [path, init] of protectedRequests) {
      const response = await app.request(`http://localhost${path}`, init);
      expect(response.status, `${init?.method ?? "GET"} ${path}`).toBe(401);
      expect(await response.json()).toMatchObject({ ok: false, code: "AUTH_REQUIRED" });
    }

    expect(
      (
        await app.request("http://localhost/api/capabilities", {
          headers: { authorization: "Bearer wrong-token" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request("http://localhost/api/capabilities", {
          headers: { authorization: "Bearer legacy-bootstrap-token" },
        })
      ).status,
    ).toBe(200);
  });

  test("retires the legacy bootstrap token immediately after owner setup", async () => {
    const { app } = await backend();
    const setup = await app.request("http://localhost/api/identity/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "owner",
        email: "owner@example.com",
        password: "correct horse battery staple",
      }),
    });
    expect(setup.status).toBe(201);

    const legacy = await app.request("http://localhost/api/capabilities", {
      headers: { authorization: "Bearer legacy-bootstrap-token" },
    });
    expect(legacy.status).toBe(401);
    expect(await legacy.json()).toMatchObject({ code: "AUTH_REQUIRED" });
  });
});
