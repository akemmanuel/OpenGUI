import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createBackendHost } from "../create-backend-host.ts";
import { readBackendHostEnv } from "../host/env.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function temporaryHost() {
  const root = await mkdtemp(join(tmpdir(), "opengui-multi-user-"));
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const project = join(root, "project");
  await writeFile(join(await mkdtemp(join(root, "proj-")), "keep.txt"), "x").catch(() => undefined);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "readme.txt"), "hello");

  const previousDataDirectory = process.env.OPENGUI_DATA_DIR;
  process.env.OPENGUI_DATA_DIR = join(root, "host-data");
  const backend = createBackendHost({
    env: {
      ...readBackendHostEnv(),
      identityMode: "remote",
      pathGrantsMode: "enforced",
      allowedRoots: [root],
      authToken: "",
      allowedCorsOrigin: "*",
      servesFrontend: false,
    },
    identityDatabasePath: join(root, "identity.sqlite"),
    identitySecret: "multi-user-access-secret-with-at-least-32-characters",
    identityBaseURL: "http://localhost",
  });
  if (previousDataDirectory === undefined) delete process.env.OPENGUI_DATA_DIR;
  else process.env.OPENGUI_DATA_DIR = previousDataDirectory;
  await backend.ready;
  await backend.hostReady;

  return { backend, project, root };
}

function authorization(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function setupOwner(backend: ReturnType<typeof createBackendHost>) {
  const response = await backend.app.request("http://localhost/api/identity/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "owner_user",
      email: "owner@example.com",
      password: "owner password is sufficiently long",
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { value: { token: string; actor: { id: string } } }).value;
}

describe("multi-user Host access", () => {
  test("open registration, canInvite, private sessions, and view links", async () => {
    const { backend, project } = await temporaryHost();
    const owner = await setupOwner(backend);

    expect(
      await (await backend.app.request("http://localhost/api/identity/policy")).json(),
    ).toMatchObject({
      ok: true,
      value: { registrationMode: "invite_only", identity: "ready" },
    });

    const closedRegister = await backend.app.request("http://localhost/api/identity/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "open_user",
        email: "open@example.com",
        password: "open password is sufficiently long",
      }),
    });
    expect(closedRegister.status).toBe(403);

    expect(
      (
        await backend.app.request("http://localhost/api/identity/host-policy", {
          method: "PUT",
          headers: {
            ...authorization(owner.token),
            "content-type": "application/json",
          },
          body: JSON.stringify({ registrationMode: "open" }),
        })
      ).status,
    ).toBe(200);

    const registered = await backend.app.request("http://localhost/api/identity/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "open_user",
        email: "open@example.com",
        password: "open password is sufficiently long",
      }),
    });
    expect(registered.status).toBe(201);
    const openUser = (await registered.json()) as {
      value: { token: string; actor: { id: string } };
    };

    // Share-only remote: open user has no path grants by default.
    expect(
      (
        await backend.app.request(
          `http://localhost/api/host/projects?directory=${encodeURIComponent(project)}`,
          { method: "POST", headers: authorization(openUser.value.token) },
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);

    await backend.app.request(
      `http://localhost/api/identity/members/${openUser.value.actor.id}/path-grants`,
      {
        method: "PUT",
        headers: {
          ...authorization(owner.token),
          "content-type": "application/json",
        },
        body: JSON.stringify({ grants: [{ root: project, access: "write" }] }),
      },
    );

    expect(
      (
        await backend.app.request("http://localhost/api/identity/invites", {
          method: "POST",
          headers: {
            ...authorization(openUser.value.token),
            "content-type": "application/json",
          },
          body: JSON.stringify({ email: "friend@example.com" }),
        })
      ).status,
    ).toBe(403);

    expect(
      (
        await backend.app.request(
          `http://localhost/api/identity/members/${openUser.value.actor.id}/can-invite`,
          {
            method: "PUT",
            headers: {
              ...authorization(owner.token),
              "content-type": "application/json",
            },
            body: JSON.stringify({ canInvite: true }),
          },
        )
      ).status,
    ).toBe(200);

    const inviteResponse = await backend.app.request("http://localhost/api/identity/invites", {
      method: "POST",
      headers: {
        ...authorization(openUser.value.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: "friend@example.com",
        pathGrants: [{ root: project, access: "read" }],
      }),
    });
    expect(inviteResponse.status).toBe(201);

    const model = await backend.app.request("http://localhost/api/host/models", {
      method: "POST",
      headers: {
        ...authorization(owner.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "no-network-test-model",
        label: "No-network test model",
        baseUrl: "http://127.0.0.1/unused",
        modelIds: ["test-model"],
      }),
    });
    expect(model.status).toBe(200);
    expect(await model.json()).toMatchObject({
      value: { id: "no-network-test-model", plane: "host" },
    });

    const hiddenModels = await backend.app.request("http://localhost/api/host/models", {
      headers: authorization(openUser.value.token),
    });
    expect((await hiddenModels.json()) as { value: unknown[] }).toMatchObject({ value: [] });

    const entitlement = await backend.app.request(
      "http://localhost/api/identity/model-connections/no-network-test-model/entitlements",
      {
        method: "PUT",
        headers: { ...authorization(owner.token), "content-type": "application/json" },
        body: JSON.stringify({
          entitlements: [{ subjectType: "team", subjectId: "host_default", modelId: "test-model" }],
        }),
      },
    );
    expect(entitlement.status).toBe(200);
    const entitledModels = await backend.app.request("http://localhost/api/host/models", {
      headers: authorization(openUser.value.token),
    });
    expect(await entitledModels.json()).toMatchObject({
      value: [{ id: "no-network-test-model", plane: "host" }],
    });

    const personal = await backend.app.request("http://localhost/api/host/models", {
      method: "POST",
      headers: { ...authorization(openUser.value.token), "content-type": "application/json" },
      body: JSON.stringify({
        id: "open-user-personal",
        label: "Private key",
        baseUrl: "http://127.0.0.1/private",
        apiKey: "must-never-be-listed",
        modelIds: ["private-model"],
        plane: "user",
      }),
    });
    const personalBody = await personal.json();
    expect(personal.status).toBe(200);
    expect(personalBody).toMatchObject({
      value: { id: "open-user-personal", plane: "user" },
    });
    expect(
      JSON.stringify(
        await (
          await backend.app.request("http://localhost/api/host/models", {
            headers: authorization(openUser.value.token),
          })
        ).json(),
      ),
    ).not.toContain("must-never-be-listed");
    expect(
      JSON.stringify(
        await (
          await backend.app.request("http://localhost/api/host/models", {
            headers: authorization(owner.token),
          })
        ).json(),
      ),
    ).not.toContain("open-user-personal");

    const ownerSession = await backend.app.request("http://localhost/api/host/sessions", {
      method: "POST",
      headers: {
        ...authorization(owner.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        directory: project,
        model: { connectionId: "no-network-test-model", modelId: "test-model" },
        reasoning: "none",
      }),
    });
    expect(ownerSession.status).toBe(200);
    const ownerSessionId = ((await ownerSession.json()) as { value: { id: string } }).value.id;
    expect(
      (
        await backend.app.request(`http://localhost/api/host/sessions/${ownerSessionId}`, {
          headers: authorization(openUser.value.token),
        })
      ).status,
    ).toBe(404);

    const teamRunShare = await backend.app.request(
      `http://localhost/api/identity/sessions/${ownerSessionId}/shares`,
      {
        method: "POST",
        headers: { ...authorization(owner.token), "content-type": "application/json" },
        body: JSON.stringify({
          granteeType: "team",
          granteeId: "host_default",
          role: "run",
        }),
      },
    );
    expect(teamRunShare.status).toBe(201);
    await expect(
      backend.identity!.authorizeSessionAction(
        ownerSessionId,
        {
          type: "user",
          id: openUser.value.actor.id,
          displayName: "open_user",
          role: "member",
        },
        "run",
      ),
    ).resolves.toBeUndefined();

    const viewLink = await backend.app.request(
      `http://localhost/api/identity/sessions/${ownerSessionId}/view-links`,
      {
        method: "POST",
        headers: authorization(owner.token),
      },
    );
    expect(viewLink.status).toBe(201);
    const token = ((await viewLink.json()) as { value: { token: string } }).value.token;
    const resolved = await backend.app.request(
      `http://localhost/api/identity/session-view-links/resolve?token=${encodeURIComponent(token)}`,
    );
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({
      ok: true,
      value: { sessionId: ownerSessionId, access: "view" },
    });
  }, 20_000);
});
