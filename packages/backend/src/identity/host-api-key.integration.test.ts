import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createBackendHost, type BackendHost } from "../create-backend-host.ts";
import type { BackendHostEnv } from "../host/env.ts";

const backends: BackendHost[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const backend of backends.splice(0)) {
    await (await backend.hostReady).close();
    backend.identity?.database.close();
  }
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("Host API key product access", () => {
  test("owner and entitled member keys can select shared models for automation Sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-api-key-models-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    await mkdir(project);
    const previousDataDirectory = process.env.OPENGUI_DATA_DIR;
    process.env.OPENGUI_DATA_DIR = join(root, "data");
    const env: BackendHostEnv = {
      port: 0,
      hostname: "127.0.0.1",
      isProduction: true,
      serverMode: "api-only",
      servesFrontend: false,
      authToken: "",
      allowedCorsOrigin: "https://client.example",
      allowedRoots: [root],
      uploadMaxFileBytes: 1024,
      uploadMaxBatchBytes: 2048,
      identityMode: "remote",
      pathGrantsMode: "disabled",
    };
    const backend = createBackendHost({
      env,
      identityDatabase: new DatabaseSync(":memory:"),
      identitySecret: "api-key-model-test-secret-with-at-least-32-characters",
      identityBaseURL: "http://localhost",
    });
    if (previousDataDirectory === undefined) delete process.env.OPENGUI_DATA_DIR;
    else process.env.OPENGUI_DATA_DIR = previousDataDirectory;
    backends.push(backend);
    await backend.ready;

    const setup = await backend.app.request("http://localhost/api/identity/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "owner",
        email: "owner@example.com",
        password: "owner password is sufficiently long",
      }),
    });
    const ownerToken = ((await setup.json()) as { value: { token: string } }).value.token;
    expect(
      (
        await backend.app.request("http://localhost/api/host/models", {
          method: "POST",
          headers: { ...bearer(ownerToken), "content-type": "application/json" },
          body: JSON.stringify({
            id: "shared-offline",
            label: "Shared offline fixture",
            baseUrl: "http://127.0.0.1/unused",
            modelIds: ["fixture-model"],
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await backend.app.request(
          "http://localhost/api/identity/model-connections/shared-offline/entitlements",
          {
            method: "PUT",
            headers: { ...bearer(ownerToken), "content-type": "application/json" },
            body: JSON.stringify({
              entitlements: [
                { subjectType: "team", subjectId: "host_default", modelId: "fixture-model" },
              ],
            }),
          },
        )
      ).status,
    ).toBe(200);

    const keys = await Promise.all(
      (["owner", "member"] as const).map(async (role) => {
        const response = await backend.app.request("http://localhost/api/identity/api-keys", {
          method: "POST",
          headers: { ...bearer(ownerToken), "content-type": "application/json" },
          body: JSON.stringify({ label: `${role} automation`, role }),
        });
        expect(response.status).toBe(201);
        return ((await response.json()) as { value: { secret: string } }).value.secret;
      }),
    );

    for (const secret of keys) {
      const models = await backend.app.request("http://localhost/api/host/models", {
        headers: bearer(secret),
      });
      expect(await models.json()).toMatchObject({
        ok: true,
        value: [{ id: "shared-offline", plane: "host" }],
      });
      const created = await backend.app.request("http://localhost/api/host/sessions", {
        method: "POST",
        headers: { ...bearer(secret), "content-type": "application/json" },
        body: JSON.stringify({
          directory: project,
          model: { connectionId: "shared-offline", modelId: "fixture-model" },
          reasoning: "none",
        }),
      });
      expect(created.status).toBe(200);
    }
  }, 20_000);
});
