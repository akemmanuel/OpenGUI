import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function authorization(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("enforced identity path grants through createBackendHost", () => {
  describe("member lifecycle", () => {
    test("denies members by default, atomically applies owner grants, blocks escapes, and revokes access through real Better Auth HTTP middleware", async () => {
      const temporaryDirectory = await mkdtemp(join(tmpdir(), "opengui-path-grants-e2e-"));
      temporaryDirectories.push(temporaryDirectory);
      const allowedRoot = join(temporaryDirectory, "allowed");
      const grantedProject = join(allowedRoot, "project");
      const writableDirectory = join(grantedProject, "writable");
      const sibling = join(allowedRoot, "sibling");
      const prefixEscape = join(allowedRoot, "project-private");
      await Promise.all([
        mkdir(writableDirectory, { recursive: true }),
        mkdir(sibling, { recursive: true }),
        mkdir(prefixEscape, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(grantedProject, "visible.txt"), "member-visible"),
        writeFile(join(sibling, "secret.txt"), "sibling-secret"),
        writeFile(join(prefixEscape, "secret.txt"), "prefix-secret"),
      ]);
      await symlink(sibling, join(grantedProject, "escape"), "dir");

      const env: BackendHostEnv = {
        port: 0,
        hostname: "127.0.0.1",
        isProduction: true,
        serverMode: "api-only",
        servesFrontend: false,
        authToken: "",
        allowedCorsOrigin: "https://client.example",
        allowedRoots: [allowedRoot],
        uploadMaxFileBytes: 1024,
        uploadMaxBatchBytes: 2048,
        identityMode: "remote",
        pathGrantsMode: "enforced",
      };
      const databasePath = join(temporaryDirectory, "identity.sqlite");
      const previousDataDirectory = process.env.OPENGUI_DATA_DIR;
      process.env.OPENGUI_DATA_DIR = join(temporaryDirectory, "host-data");
      let backend: BackendHost;
      try {
        backend = createBackendHost({
          env,
          identityDatabasePath: databasePath,
          identitySecret: "end-to-end-path-grant-secret-with-at-least-32-characters",
          identityBaseURL: "http://localhost",
        });
      } finally {
        if (previousDataDirectory === undefined) delete process.env.OPENGUI_DATA_DIR;
        else process.env.OPENGUI_DATA_DIR = previousDataDirectory;
      }
      backends.push(backend);
      await backend.ready;
      expect((await stat(databasePath)).isFile()).toBe(true);

      const setup = await backend.app.request("http://localhost/api/identity/setup", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://client.example" },
        body: JSON.stringify({
          username: "path_owner",
          email: "owner@example.com",
          password: "owner password is sufficiently long",
        }),
      });
      expect(setup.status).toBe(201);
      const ownerToken = ((await setup.json()) as { value: { token: string } }).value.token;

      const model = await backend.app.request("http://localhost/api/host/models", {
        method: "POST",
        headers: { ...authorization(ownerToken), "content-type": "application/json" },
        body: JSON.stringify({
          id: "no-network-test-model",
          label: "No-network test model",
          baseUrl: "http://127.0.0.1/unused",
          modelIds: ["test-model"],
        }),
      });
      expect(model.status).toBe(200);

      const ownerSessionResponse = await backend.app.request("http://localhost/api/host/sessions", {
        method: "POST",
        headers: { ...authorization(ownerToken), "content-type": "application/json" },
        body: JSON.stringify({
          directory: sibling,
          model: { connectionId: "no-network-test-model", modelId: "test-model" },
          reasoning: "none",
        }),
      });
      expect(ownerSessionResponse.status).toBe(200);
      const ownerSessionId = ((await ownerSessionResponse.json()) as { value: { id: string } })
        .value.id;
      const ownerFile = await backend.app.request(
        `http://localhost/api/fs/file?path=${encodeURIComponent(join(sibling, "secret.txt"))}`,
        { headers: authorization(ownerToken) },
      );
      expect(ownerFile.status).toBe(200);
      expect(await ownerFile.text()).toBe("sibling-secret");

      const inviteResponse = await backend.app.request("http://localhost/api/identity/invites", {
        method: "POST",
        headers: { ...authorization(ownerToken), "content-type": "application/json" },
        body: JSON.stringify({ email: "member@example.com" }),
      });
      expect(inviteResponse.status).toBe(201);
      const inviteToken = ((await inviteResponse.json()) as { value: { token: string } }).value
        .token;
      const accepted = await backend.app.request("http://localhost/api/identity/invites/accept", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://client.example" },
        body: JSON.stringify({
          token: inviteToken,
          username: "path_member",
          email: "member@example.com",
          password: "member password is sufficiently long",
        }),
      });
      expect(accepted.status).toBe(201);
      const member = (await accepted.json()) as {
        value: { token: string; actor: { id: string } };
      };
      const memberToken = member.value.token;
      const memberHeaders = authorization(memberToken);

      const projectRequest = (directory: string) =>
        backend.app.request("http://localhost/api/host/projects", {
          method: "POST",
          headers: { ...memberHeaders, "content-type": "application/json" },
          body: JSON.stringify({ directory }),
        });
      const sessionRequest = () =>
        backend.app.request("http://localhost/api/host/sessions", {
          method: "POST",
          headers: { ...memberHeaders, "content-type": "application/json" },
          body: JSON.stringify({
            directory: grantedProject,
            model: { connectionId: "no-network-test-model", modelId: "test-model" },
            reasoning: "none",
          }),
        });
      const memberFileRequest = (path: string) =>
        backend.app.request(`http://localhost/api/fs/file?path=${encodeURIComponent(path)}`, {
          headers: memberHeaders,
        });

      expect((await projectRequest(grantedProject)).status).toBe(403);
      expect((await memberFileRequest(join(grantedProject, "visible.txt"))).status).toBe(403);
      expect((await sessionRequest()).status).toBe(403);
      expect(
        (
          await backend.app.request(`http://localhost/api/host/sessions/${ownerSessionId}`, {
            headers: memberHeaders,
          })
        ).status,
      ).toBe(404);

      const memberGrantAttempt = await backend.app.request(
        `http://localhost/api/identity/members/${member.value.actor.id}/path-grants`,
        {
          method: "PUT",
          headers: { ...memberHeaders, "content-type": "application/json" },
          body: JSON.stringify({ grants: [{ root: grantedProject, access: "write" }] }),
        },
      );
      expect(memberGrantAttempt.status).toBe(403);

      const grantResponse = await backend.app.request(
        `http://localhost/api/identity/members/${member.value.actor.id}/path-grants`,
        {
          method: "PUT",
          headers: { ...authorization(ownerToken), "content-type": "application/json" },
          body: JSON.stringify({
            grants: [
              { root: grantedProject, access: "read" },
              { root: writableDirectory, access: "write" },
            ],
          }),
        },
      );
      expect(grantResponse.status).toBe(200);
      expect(await grantResponse.json()).toMatchObject({
        ok: true,
        value: {
          revision: 1,
          grants: [
            { root: grantedProject, access: "read" },
            { root: writableDirectory, access: "write" },
          ],
        },
      });

      expect((await projectRequest(grantedProject)).status).toBe(200);
      const grantedFile = await memberFileRequest(join(grantedProject, "visible.txt"));
      expect(grantedFile.status).toBe(200);
      expect(await grantedFile.text()).toBe("member-visible");

      const upload = new FormData();
      upload.append("directory", writableDirectory);
      upload.append("files", new File(["uploaded-content"], "upload.txt"));
      const uploadResponse = await backend.app.request("http://localhost/api/fs/upload", {
        method: "POST",
        headers: memberHeaders,
        body: upload,
      });
      expect(uploadResponse.status).toBe(200);
      const uploadedPath = ((await uploadResponse.json()) as { value: string[] }).value[0]!;
      expect(await readFile(uploadedPath, "utf8")).toBe("uploaded-content");

      const modelEntitlement = await backend.app.request(
        "http://localhost/api/identity/model-connections/no-network-test-model/entitlements",
        {
          method: "PUT",
          headers: { ...authorization(ownerToken), "content-type": "application/json" },
          body: JSON.stringify({
            entitlements: [
              {
                subjectType: "user",
                subjectId: member.value.actor.id,
                modelId: "test-model",
              },
            ],
          }),
        },
      );
      expect(modelEntitlement.status).toBe(200);

      const memberSessionResponse = await sessionRequest();
      expect(memberSessionResponse.status).toBe(200);
      const memberSessionId = ((await memberSessionResponse.json()) as { value: { id: string } })
        .value.id;
      expect(
        (
          await backend.app.request(`http://localhost/api/host/sessions/${memberSessionId}`, {
            headers: memberHeaders,
          })
        ).status,
      ).toBe(200);

      for (const escapedPath of [
        join(sibling, "secret.txt"),
        join(prefixEscape, "secret.txt"),
        join(grantedProject, "escape", "secret.txt"),
      ]) {
        expect((await memberFileRequest(escapedPath)).status).toBe(403);
      }
      expect((await projectRequest(sibling)).status).toBe(403);
      expect((await projectRequest(prefixEscape)).status).toBe(403);
      expect((await projectRequest(join(grantedProject, "escape"))).status).toBe(403);

      const revokeGrants = await backend.app.request(
        `http://localhost/api/identity/members/${member.value.actor.id}/path-grants`,
        {
          method: "PUT",
          headers: { ...authorization(ownerToken), "content-type": "application/json" },
          body: JSON.stringify({ grants: [] }),
        },
      );
      expect(revokeGrants.status).toBe(200);
      expect(await revokeGrants.json()).toMatchObject({
        ok: true,
        value: { revision: 2, grants: [] },
      });
      expect((await memberFileRequest(join(grantedProject, "visible.txt"))).status).toBe(403);
      expect((await projectRequest(grantedProject)).status).toBe(403);
      expect(
        (
          await backend.app.request(`http://localhost/api/host/sessions/${memberSessionId}`, {
            headers: memberHeaders,
          })
        ).status,
      ).toBe(404);
      // Sessions are user-owned; path grants do not imply transcript access.
      expect(
        (
          await backend.app.request(`http://localhost/api/host/sessions/${memberSessionId}`, {
            headers: authorization(ownerToken),
          })
        ).status,
      ).toBe(404);

      const removed = await backend.app.request(
        `http://localhost/api/identity/members/${member.value.actor.id}`,
        { method: "DELETE", headers: authorization(ownerToken) },
      );
      expect(removed.status).toBe(200);
      expect(
        (
          await backend.app.request("http://localhost/api/capabilities", {
            headers: memberHeaders,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await backend.app.request(`http://localhost/api/host/sessions/${ownerSessionId}`, {
            headers: authorization(ownerToken),
          })
        ).status,
      ).toBe(200);
    }, 20_000);
  });
});
