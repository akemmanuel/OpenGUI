import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { createBackendHost, type BackendHost } from "../create-backend-host.ts";
import type { BackendHostEnv } from "../host/env.ts";

let backend: BackendHost;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "opengui-route-auth-inventory-"));
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
    pathGrantsMode: "enforced",
  };
  backend = createBackendHost({
    env,
    identityDatabase: new DatabaseSync(":memory:"),
    identitySecret: "route-auth-inventory-secret-with-at-least-32-characters",
    identityBaseURL: "http://localhost",
  });
  if (previousDataDirectory === undefined) delete process.env.OPENGUI_DATA_DIR;
  else process.env.OPENGUI_DATA_DIR = previousDataDirectory;
  await backend.ready;
});

afterAll(async () => {
  await (await backend.hostReady).close();
  backend.identity?.database.close();
  await rm(root, { recursive: true });
});

const protectedRoutes: Array<[method: string, path: string]> = [
  ["GET", "/api/capabilities"],
  ["GET", "/api/version"],
  ["POST", "/api/rpc"],
  ["GET", "/api/fs/list"],
  ["GET", "/api/fs/roots"],
  ["GET", "/api/fs/file"],
  ["GET", "/api/fs/search"],
  ["POST", "/api/fs/upload"],
  ["GET", "/api/host/models"],
  ["GET", "/api/host/model-offerings"],
  ["POST", "/api/host/models"],
  ["DELETE", "/api/host/models/model"],
  ["GET", "/api/host/mcp-connections"],
  ["POST", "/api/host/mcp-connections"],
  ["GET", "/api/host/custom-instructions"],
  ["PUT", "/api/host/custom-instructions"],
  ["POST", "/api/host/mcp-connections/connection/inspect"],
  ["DELETE", "/api/host/mcp-connections/connection"],
  ["GET", "/api/host/auth/codex"],
  ["POST", "/api/host/auth/codex"],
  ["POST", "/api/host/auth/codex/poll"],
  ["POST", "/api/host/auth/codex/cancel"],
  ["DELETE", "/api/host/auth/codex"],
  ["GET", "/api/host/auth/xai"],
  ["POST", "/api/host/auth/xai"],
  ["POST", "/api/host/auth/xai/poll"],
  ["POST", "/api/host/auth/xai/cancel"],
  ["DELETE", "/api/host/auth/xai"],
  ["GET", "/api/host/projects"],
  ["POST", "/api/host/projects"],
  ["DELETE", "/api/host/projects"],
  ["GET", "/api/host/skills"],
  ["GET", "/api/host/skills/sources"],
  ["GET", "/api/host/skills/installations"],
  ["POST", "/api/host/skills/install"],
  ["POST", "/api/host/skills/skill/update"],
  ["DELETE", "/api/host/skills/skill"],
  ["GET", "/api/host/sessions"],
  ["POST", "/api/host/session-message-search"],
  ["POST", "/api/host/sessions"],
  ["GET", "/api/host/sessions/session"],
  ["PATCH", "/api/host/sessions/session"],
  ["DELETE", "/api/host/sessions/session"],
  ["POST", "/api/host/sessions/session/compact"],
  ["POST", "/api/host/sessions/session/prompt"],
  ["PATCH", "/api/host/sessions/session/follow-ups/follow-up"],
  ["POST", "/api/host/sessions/session/follow-ups/follow-up/reorder"],
  ["DELETE", "/api/host/sessions/session/follow-ups/follow-up"],
  ["POST", "/api/host/sessions/session/follow-ups/follow-up/send-now"],
  ["POST", "/api/host/sessions/session/abort"],
  ["GET", "/api/host/events"],
  ["POST", "/api/identity/logout"],
  ["POST", "/api/auth/logout"],
  ["GET", "/api/identity/me"],
  ["GET", "/api/auth/me"],
  ["GET", "/api/identity/audit"],
  ["GET", "/api/identity/host-policy"],
  ["PUT", "/api/identity/host-policy"],
  ["POST", "/api/identity/invites"],
  ["GET", "/api/identity/invites"],
  ["DELETE", "/api/identity/invites/invite"],
  ["GET", "/api/identity/share-principals"],
  ["GET", "/api/identity/members"],
  ["DELETE", "/api/identity/members/member"],
  ["POST", "/api/identity/members/member/reset-password"],
  ["PUT", "/api/identity/members/member/can-invite"],
  ["PUT", "/api/identity/members/member/role"],
  ["GET", "/api/identity/sessions/session/shares"],
  ["POST", "/api/identity/sessions/session/shares"],
  ["DELETE", "/api/identity/sessions/session/shares/user/member"],
  ["GET", "/api/identity/sessions/session/view-links"],
  ["POST", "/api/identity/sessions/session/view-links"],
  ["DELETE", "/api/identity/session-view-links/link"],
  ["GET", "/api/identity/model-policy"],
  ["PUT", "/api/identity/model-policy"],
  ["GET", "/api/identity/model-connections/connection/entitlements"],
  ["PUT", "/api/identity/model-connections/connection/entitlements"],
  ["POST", "/api/identity/model-offerings"],
  ["PUT", "/api/identity/model-offerings/offering"],
  ["DELETE", "/api/identity/model-offerings/offering"],
  ["GET", "/api/identity/model-offerings/offering/entitlements"],
  ["PUT", "/api/identity/model-offerings/offering/entitlements"],
  ["POST", "/api/identity/api-keys"],
  ["GET", "/api/identity/api-keys"],
  ["DELETE", "/api/identity/api-keys/key"],
  ["GET", "/api/identity/members/member/path-grants"],
  ["PUT", "/api/identity/members/member/path-grants"],
  ["GET", "/api/identity/api-keys/key/path-grants"],
  ["PUT", "/api/identity/api-keys/key/path-grants"],
];

describe("exported Remote Host route authentication inventory", () => {
  test.each(protectedRoutes)("%s %s rejects anonymous callers", async (method, path) => {
    const response = await backend.app.request(`http://localhost${path}`, { method });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "AUTH_REQUIRED" });
  });

  test.each([
    ["GET", "/api/health"],
    ["GET", "/api/host/health"],
    ["POST", "/api/identity/setup"],
    ["POST", "/api/identity/login"],
    ["POST", "/api/auth/login"],
    ["GET", "/api/identity/policy"],
    ["POST", "/api/identity/register"],
    ["POST", "/api/identity/invites/accept"],
    ["GET", "/api/identity/session-view-links/resolve"],
  ])("%s %s remains an anonymous entry point", async (method, path) => {
    expect((await backend.app.request(`http://localhost${path}`, { method })).status).not.toBe(401);
  });

  test("preflight is body-free, unauthenticated, and carries the configured CORS policy", async () => {
    const response = await backend.app.request("http://localhost/api/host/sessions", {
      method: "OPTIONS",
      headers: {
        origin: "https://client.example",
        "access-control-request-method": "POST",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://client.example");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });
});
