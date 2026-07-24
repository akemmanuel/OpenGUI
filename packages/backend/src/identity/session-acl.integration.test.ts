import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { ModelTransport } from "@opengui/harness";
import { createBackendHost, type BackendHost } from "../create-backend-host.ts";
import type { BackendHostEnv } from "../host/env.ts";
import { seeded } from "../test/seeded.ts";

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

describe("Remote Session ACL HTTP contracts", () => {
  test("view, admin, Team run, owner delete, and public view-link capabilities stay distinct", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-session-acl-"));
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
    const model: ModelTransport = {
      async *stream() {
        yield { type: "text_delta", delta: "offline fixture" };
        yield { type: "completed" };
      },
    };
    const backend = createBackendHost({
      env,
      model,
      identityDatabase: new DatabaseSync(":memory:"),
      identitySecret: "session-acl-test-secret-with-at-least-32-characters",
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
    const owner = (await setup.json()) as {
      value: {
        token: string;
        actor: { type: "user"; id: string; displayName: string; role: "owner" };
      };
    };
    await backend.app.request("http://localhost/api/identity/host-policy", {
      method: "PUT",
      headers: { ...bearer(owner.value.token), "content-type": "application/json" },
      body: JSON.stringify({ registrationMode: "open" }),
    });
    const registration = await backend.app.request("http://localhost/api/identity/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "member",
        email: "member@example.com",
        password: "member password is sufficiently long",
      }),
    });
    const member = (await registration.json()) as {
      value: { token: string; actor: { id: string } };
    };

    await backend.app.request("http://localhost/api/host/models", {
      method: "POST",
      headers: { ...bearer(owner.value.token), "content-type": "application/json" },
      body: JSON.stringify({
        id: "shared",
        label: "Shared fixture",
        baseUrl: "http://offline.test/v1",
        modelIds: ["fixture-model"],
      }),
    });
    await backend.app.request(
      "http://localhost/api/identity/model-connections/shared/entitlements",
      {
        method: "PUT",
        headers: { ...bearer(owner.value.token), "content-type": "application/json" },
        body: JSON.stringify({
          entitlements: [
            { subjectType: "team", subjectId: "host_default", modelId: "fixture-model" },
          ],
        }),
      },
    );
    const created = await backend.app.request("http://localhost/api/host/sessions", {
      method: "POST",
      headers: { ...bearer(owner.value.token), "content-type": "application/json" },
      body: JSON.stringify({
        directory: project,
        model: { connectionId: "shared", modelId: "fixture-model" },
        reasoning: "none",
      }),
    });
    const sessionId = ((await created.json()) as { value: { id: string } }).value.id;
    const sessionUrl = `http://localhost/api/host/sessions/${sessionId}`;
    const memberHeaders = bearer(member.value.token);

    expect((await backend.app.request(sessionUrl, { headers: memberHeaders })).status).toBe(404);

    const share = (granteeType: "user" | "team", granteeId: string, role: string) =>
      backend.app.request(`http://localhost/api/identity/sessions/${sessionId}/shares`, {
        method: "POST",
        headers: { ...bearer(owner.value.token), "content-type": "application/json" },
        body: JSON.stringify({ granteeType, granteeId, role }),
      });
    expect((await share("user", member.value.actor.id, "view")).status).toBe(201);
    expect((await backend.app.request(sessionUrl, { headers: memberHeaders })).status).toBe(200);
    expect(
      (
        await backend.app.request(sessionUrl, {
          method: "PATCH",
          headers: { ...memberHeaders, "content-type": "application/json" },
          body: JSON.stringify({ title: "not allowed" }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await backend.app.request(`${sessionUrl}/prompt`, {
          method: "POST",
          headers: { ...memberHeaders, "content-type": "application/json" },
          body: JSON.stringify({ text: "not allowed" }),
        })
      ).status,
    ).toBe(404);

    expect((await share("user", member.value.actor.id, "admin")).status).toBe(201);
    expect(
      (
        await backend.app.request(sessionUrl, {
          method: "PATCH",
          headers: { ...memberHeaders, "content-type": "application/json" },
          body: JSON.stringify({ title: "Admin rename" }),
        })
      ).status,
    ).toBe(200);
    expect(
      (await backend.app.request(sessionUrl, { method: "DELETE", headers: memberHeaders })).status,
    ).toBe(404);

    expect((await share("team", "host_default", "run")).status).toBe(201);
    expect(
      (
        await backend.app.request(`${sessionUrl}/prompt`, {
          method: "POST",
          headers: { ...memberHeaders, "content-type": "application/json" },
          body: JSON.stringify({ text: "Team collaboration" }),
        })
      ).status,
    ).toBe(200);
    await (
      await backend.hostReady
    ).waitForIdle(sessionId, {
      type: "user",
      id: member.value.actor.id,
      displayName: "member",
    });

    // Exercise the ACL resolver independently of HTTP routing: user admin and Team run
    // combine, but neither can acquire owner-only deletion. Fixed ordering makes failures replayable.
    const random = seeded(0x41434c31);
    const memberActor = {
      type: "user" as const,
      id: member.value.actor.id,
      displayName: "member",
      role: "member" as const,
    };
    const actions = ["view", "run", "admin", "delete"] as const;
    for (let iteration = 0; iteration < 300; iteration += 1) {
      const action = random.pick(actions);
      const authorization = backend.identity!.authorizeSessionAction(
        sessionId,
        memberActor,
        action,
      );
      if (action === "delete")
        await expect(authorization, `${iteration}: ${action}`).rejects.toThrow("Session not found");
      else await expect(authorization, `${iteration}: ${action}`).resolves.toBeUndefined();
    }
    await backend.identity!.revokeSessionShare(
      owner.value.actor,
      sessionId,
      "team",
      "host_default",
    );
    await expect(
      backend.identity!.authorizeSessionAction(sessionId, memberActor, "run"),
    ).rejects.toThrow("Session not found");
    await expect(
      backend.identity!.authorizeSessionAction(sessionId, memberActor, "admin"),
    ).resolves.toBeUndefined();
    await backend.identity!.shareSession(owner.value.actor, sessionId, {
      granteeType: "team",
      granteeId: "host_default",
      role: "run",
    });

    const viewLink = await backend.app.request(
      `http://localhost/api/identity/sessions/${sessionId}/view-links`,
      { method: "POST", headers: memberHeaders },
    );
    expect(viewLink.status).toBe(201);
    const link = (await viewLink.json()) as { value: { id: string; token: string } };
    const resolveUrl = `http://localhost/api/identity/session-view-links/resolve?token=${encodeURIComponent(link.value.token)}`;
    expect(await (await backend.app.request(resolveUrl)).json()).toMatchObject({
      ok: true,
      value: { sessionId, access: "view", session: { id: sessionId } },
    });
    expect(
      (
        await backend.app.request(`${sessionUrl}/prompt`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${link.value.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ text: "view links never run" }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await backend.app.request(
          `http://localhost/api/identity/session-view-links/${link.value.id}`,
          { method: "DELETE", headers: memberHeaders },
        )
      ).status,
    ).toBe(200);
    expect((await backend.app.request(resolveUrl)).status).toBe(410);

    expect(
      (
        await backend.app.request(sessionUrl, {
          method: "DELETE",
          headers: bearer(owner.value.token),
        })
      ).status,
    ).toBe(200);
  }, 20_000);
});
