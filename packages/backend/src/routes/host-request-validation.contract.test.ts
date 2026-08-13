import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { createBackendHost, type BackendHost } from "../create-backend-host.ts";
import type { BackendHostEnv } from "../host/env.ts";

let backend: BackendHost;
let root: string;
let previousDataDirectory: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "opengui-request-contract-"));
  await mkdir(join(root, "project"));
  previousDataDirectory = process.env.OPENGUI_DATA_DIR;
  process.env.OPENGUI_DATA_DIR = join(root, "data");
  const env: BackendHostEnv = {
    port: 0,
    hostname: "127.0.0.1",
    isProduction: true,
    serverMode: "api-only",
    servesFrontend: false,
    authToken: "",
    allowedCorsOrigin: "*",
    allowedRoots: [root],
    uploadMaxFileBytes: 4,
    uploadMaxBatchBytes: 6,
    identityMode: "desktop-local",
    pathGrantsMode: "disabled",
  };
  (env as BackendHostEnv & { requestMaxBytes: number }).requestMaxBytes = 64;
  backend = createBackendHost({ env });
  if (previousDataDirectory === undefined) delete process.env.OPENGUI_DATA_DIR;
  else process.env.OPENGUI_DATA_DIR = previousDataDirectory;
  await backend.ready;
});

afterEach(async () => {
  await (await backend.hostReady).close();
  await rm(root, { recursive: true });
});

describe("Host request validation contracts", () => {
  test("oversized non-upload request bodies fail before JSON parsing", async () => {
    const response = await backend.app.request("http://localhost/api/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "unknown", padding: "x".repeat(100) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ ok: false, code: "REQUEST_TOO_LARGE" });
  });

  test.each([
    ["malformed JSON", "{", "application/json"],
    ["a non-object body", "null", "application/json"],
    [
      "missing files:find arguments",
      JSON.stringify({ channel: "files:find", args: [] }),
      "application/json",
    ],
    ["an unknown channel", JSON.stringify({ channel: "unknown", args: [] }), "application/json"],
  ])("RPC rejects %s as a client error", async (_label, body, contentType) => {
    const response = await backend.app.request("http://localhost/api/rpc", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, recoverable: true });
  });

  test.each([
    ["POST", "/api/host/models", "{"],
    ["PUT", "/api/host/custom-instructions", "null"],
    ["POST", "/api/host/projects", "null"],
    ["DELETE", "/api/host/projects", "[]"],
    ["POST", "/api/host/sessions", "null"],
    ["POST", "/api/host/skills/install", "null"],
    ["POST", "/api/host/skills/demo/update", "null"],
    ["PATCH", "/api/host/sessions/missing", "[]"],
    ["POST", "/api/host/sessions/missing/prompt", "null"],
    ["PATCH", "/api/host/sessions/missing/follow-ups/missing", "null"],
    [
      "POST",
      "/api/host/sessions/missing/follow-ups/missing/reorder",
      JSON.stringify({ index: "0" }),
    ],
  ])("%s %s rejects malformed input without a 500", async (method, path, body) => {
    const response = await backend.app.request(`http://localhost${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(400);
  });

  test("upload limits reject oversized individual files and batches", async () => {
    const oversizedFile = new FormData();
    oversizedFile.append("files", new File(["12345"], "large.txt"));
    const fileResponse = await backend.app.request("http://localhost/api/fs/upload", {
      method: "POST",
      body: oversizedFile,
    });
    expect(fileResponse.status).toBe(400);
    expect(await fileResponse.json()).toMatchObject({ error: "File exceeds size limit" });

    const oversizedBatch = new FormData();
    oversizedBatch.append("files", new File(["1234"], "one.txt"));
    oversizedBatch.append("files", new File(["5678"], "two.txt"));
    const batchResponse = await backend.app.request("http://localhost/api/fs/upload", {
      method: "POST",
      body: oversizedBatch,
    });
    expect(batchResponse.status).toBe(400);
    expect(await batchResponse.json()).toMatchObject({ error: "Upload batch exceeds size limit" });
  });

  test("global allowed roots reject parent traversal, sibling prefixes, and symlink escapes", async () => {
    const outside = `${root}-private`;
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "escape"), "dir");
    try {
      for (const directory of [join(root, ".."), outside, join(root, "escape")]) {
        const response = await backend.app.request("http://localhost/api/host/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory }),
        });
        expect(response.status, directory).toBe(400);
      }
      const escapedFile = await backend.app.request(
        `http://localhost/api/fs/file?path=${encodeURIComponent(join(root, "escape", "secret.txt"))}`,
      );
      expect(escapedFile.status).toBe(400);
    } finally {
      await rm(outside, { recursive: true });
    }
  });

  test("Desktop Local does not expose remote identity administration handlers", async () => {
    for (const path of [
      "/api/identity/members",
      "/api/identity/invites",
      "/api/identity/api-keys",
      "/api/identity/model-policy",
    ]) {
      const response = await backend.app.request(`http://localhost${path}`);
      expect(response.status, path).toBe(404);
    }
  });
});
