import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createBackendHost, type BackendHost } from "../create-backend-host.ts";
import type { BackendHostEnv } from "../host/env.ts";

const backends: BackendHost[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(backends.splice(0).map(async (backend) => (await backend.hostReady).close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function backend() {
  const root = await mkdtemp(join(tmpdir(), "opengui-mcp-routes-"));
  roots.push(root);
  const env: BackendHostEnv = {
    port: 0,
    hostname: "127.0.0.1",
    isProduction: true,
    serverMode: "api-only",
    servesFrontend: false,
    authToken: "",
    allowedCorsOrigin: "*",
    allowedRoots: [root],
    uploadMaxFileBytes: 1024,
    uploadMaxBatchBytes: 2048,
    identityMode: "desktop-local",
    pathGrantsMode: "disabled",
  };
  const result = createBackendHost({ env, dataDirectory: join(root, "data") });
  backends.push(result);
  await result.ready;
  return result;
}

describe("MCP connection routes", () => {
  test("requires exact-command approval and never returns stdio environment values", async () => {
    const instance = await backend();
    const connection = {
      id: "calendar",
      label: "Calendar",
      enabled: false,
      transport: {
        kind: "stdio",
        command: process.execPath,
        args: ["calendar-server.mjs"],
        env: { CALENDAR_TOKEN: "secret-value" },
      },
    };
    const denied = await instance.app.request("http://localhost/api/host/mcp-connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(connection),
    });
    expect(denied.status).toBe(400);

    const saved = await instance.app.request("http://localhost/api/host/mcp-connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...connection, commandApproved: true }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      ok: true,
      value: { transport: { envKeys: ["CALENDAR_TOKEN"] } },
    });
    const listed = await instance.app.request("http://localhost/api/host/mcp-connections");
    expect(JSON.stringify(await listed.json())).not.toContain("secret-value");

    expect(
      (
        await instance.app.request("http://localhost/api/host/mcp-connections/calendar", {
          method: "DELETE",
        })
      ).status,
    ).toBe(200);
  });
});
