import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { ModelRequest, ModelTransport } from "@opengui/harness";
import { createBackendHost, type BackendHost } from "../create-backend-host.ts";
import type { Actor } from "./types.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "opengui-offering-security-"));
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "secret.txt"), "not ambient");
  const requests: ModelRequest[] = [];
  const model: ModelTransport = {
    async *stream(request) {
      requests.push(request);
      yield { type: "completed" as const };
    },
  };
  const previous = process.env.OPENGUI_DATA_DIR;
  process.env.OPENGUI_DATA_DIR = join(root, "data");
  const backend = createBackendHost({
    env: {
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
      identityMode: "remote",
      pathGrantsMode: "enforced",
    },
    identityDatabase: new DatabaseSync(":memory:"),
    identitySecret: "offering-security-secret-with-at-least-32-characters",
    identityBaseURL: "http://localhost",
    model,
  });
  if (previous === undefined) delete process.env.OPENGUI_DATA_DIR;
  else process.env.OPENGUI_DATA_DIR = previous;
  await backend.ready;
  cleanups.push(async () => {
    await (await backend.hostReady).close();
    backend.identity!.database.close();
    await rm(root, { recursive: true, force: true });
  });
  return { backend, root, project, requests };
}

function headers(token: string, json = false) {
  return {
    authorization: `Bearer ${token}`,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

async function value<T>(response: Response) {
  const body = (await response.json()) as { value: T };
  return body.value;
}

async function setupOwner(backend: BackendHost) {
  return value<{ token: string; actor: Actor }>(
    await backend.app.request("http://localhost/api/identity/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "owner",
        email: "owner@example.com",
        password: "owner password is sufficiently long",
      }),
    }),
  );
}

async function register(backend: BackendHost, ownerToken: string, username: string) {
  await backend.app.request("http://localhost/api/identity/host-policy", {
    method: "PUT",
    headers: headers(ownerToken, true),
    body: JSON.stringify({ registrationMode: "open" }),
  });
  return value<{ token: string; actor: Actor }>(
    await backend.app.request("http://localhost/api/identity/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        email: `${username}@example.com`,
        password: `${username} password is sufficiently long`,
      }),
    }),
  );
}

describe("roles, capabilities, and model offerings", () => {
  test("named teams persist membership, enforce model grants and deny personal credentials", async () => {
    const { backend } = await fixture();
    const owner = await setupOwner(backend);
    const alice = await register(backend, owner.token, "alice");
    const bob = await register(backend, owner.token, "bob");
    const identity = backend.identity!;
    const input = {
      name: "Design",
      memberIds: [alice.actor.id],
      allowByok: false,
      allowByos: true,
    };
    const request = (path: string, token: string, method = "GET", body?: unknown) =>
      backend.app.request(`http://localhost/api/identity/${path}`, {
        method,
        headers: headers(token, true),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    expect((await request("teams", bob.token, "POST", input)).status).toBe(403);
    const created = await request("teams", owner.token, "POST", input);
    expect(created.status).toBe(200);
    const team = await value<{ id: string }>(created);
    expect(await value(await request("teams", owner.token))).toEqual(
      expect.arrayContaining([expect.objectContaining({ ...input, id: team.id })]),
    );
    expect((await request("teams", owner.token, "POST", input)).status).toBe(409);
    await identity.recordModelConnection(owner.actor, {
      id: "shared",
      plane: "host",
      credentialKind: "byok",
    });
    await identity.createModelOffering(owner.actor, {
      id: "design-model",
      displayName: "Design model",
      backendId: "shared",
      upstreamModelId: "upstream",
    });
    await identity.saveTeam(owner.actor, { ...input, modelOfferingIds: ["design-model"] }, team.id);
    await expect(
      identity.saveTeam(
        owner.actor,
        { ...input, memberIds: [bob.actor.id], modelOfferingIds: ["missing-model"] },
        team.id,
      ),
    ).rejects.toMatchObject({ code: "MODEL_OFFERING_NOT_FOUND" });
    expect((await identity.listTeams(owner.actor)).find((row) => row.id === team.id)).toMatchObject(
      { memberIds: [alice.actor.id], modelOfferingIds: ["design-model"] },
    );
    await identity.recordSessionOwner("team-session", owner.actor);
    await identity.shareSession(owner.actor, "team-session", {
      granteeType: "team",
      granteeId: team.id,
      role: "view",
    });
    await expect(
      identity.authorizeSessionAction("team-session", alice.actor, "view"),
    ).resolves.toBeUndefined();
    await expect(
      identity.authorizeSessionAction("team-session", bob.actor, "view"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(identity.resolveModelOfferingForUse(alice.actor, "design-model")).resolves.toEqual(
      { connectionId: "shared", modelId: "upstream" },
    );
    await expect(
      identity.resolveModelOfferingForUse(bob.actor, "design-model"),
    ).rejects.toMatchObject({ code: "MODEL_NOT_ENTITLED" });
    expect((await identity.listModelOfferings(alice.actor)).map((row) => row.id)).toContain(
      "design-model",
    );
    expect((await identity.getModelPolicy(alice.actor)).effective).toEqual({
      allowByok: false,
      allowByos: true,
    });
    await expect(
      identity.recordModelConnection(alice.actor, {
        id: "private",
        plane: "user",
        credentialKind: "byok",
      }),
    ).rejects.toMatchObject({ code: "MODEL_CREDENTIAL_POLICY_DENIED" });
    await identity.recordModelConnection(bob.actor, {
      id: "bob-private",
      plane: "user",
      credentialKind: "byok",
    });
    expect(
      (
        await request(`teams/${team.id}`, owner.token, "PUT", {
          ...input,
          memberIds: [bob.actor.id],
        })
      ).status,
    ).toBe(200);
    await expect(
      identity.authorizeModelSelection(bob.actor, "bob-private", "model"),
    ).rejects.toMatchObject({ code: "MODEL_NOT_ENTITLED" });
    await expect(
      identity.resolveModelOfferingForUse(alice.actor, "design-model"),
    ).rejects.toMatchObject({ code: "MODEL_NOT_ENTITLED" });
    await expect(
      identity.authorizeSessionAction("team-session", alice.actor, "view"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      identity.authorizeSessionAction("team-session", bob.actor, "view"),
    ).resolves.toBeUndefined();
    await expect(
      identity.resolveModelOfferingForUse(bob.actor, "design-model"),
    ).resolves.toBeDefined();
    expect((await request("teams/host_default", owner.token, "DELETE")).status).toBe(409);
    expect((await request(`teams/${team.id}`, owner.token, "DELETE")).status).toBe(200);
    await expect(
      identity.resolveModelOfferingForUse(bob.actor, "design-model"),
    ).rejects.toMatchObject({ code: "MODEL_NOT_ENTITLED" });
    expect(await identity.listModelOfferingEntitlements(owner.actor, "design-model")).toEqual([]);
  });
  test("keeps administration human-only and gives admin/viewer no ambient filesystem or shell", async () => {
    const { backend, root } = await fixture();
    const owner = await setupOwner(backend);
    const admin = await register(backend, owner.token, "admin_user");
    const viewer = await register(backend, owner.token, "viewer_user");
    for (const [id, role] of [
      [admin.actor.id, "admin"],
      [viewer.actor.id, "viewer"],
    ] as const) {
      expect(
        (
          await backend.app.request(`http://localhost/api/identity/members/${id}/role`, {
            method: "PUT",
            headers: headers(owner.token, true),
            body: JSON.stringify({ role }),
          })
        ).status,
      ).toBe(200);
    }

    expect(
      (
        await backend.app.request("http://localhost/api/identity/members", {
          headers: headers(admin.token),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await backend.app.request(`http://localhost/api/fs/list?path=${encodeURIComponent(root)}`, {
          headers: headers(admin.token),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await backend.app.request(`http://localhost/api/fs/list?path=${encodeURIComponent(root)}`, {
          headers: headers(viewer.token),
        })
      ).status,
    ).toBe(403);
    expect(
      (await backend.identity!.effectivePathPolicy({ ...admin.actor, role: "admin" })).shellAllowed,
    ).toBe(false);
    expect(
      (await backend.identity!.effectivePathPolicy({ ...viewer.actor, role: "viewer" }))
        .shellAllowed,
    ).toBe(false);

    const key = await value<{ secret: string }>(
      await backend.app.request("http://localhost/api/identity/api-keys", {
        method: "POST",
        headers: headers(owner.token, true),
        body: JSON.stringify({ label: "owner automation", role: "owner" }),
      }),
    );
    expect(
      (
        await backend.app.request("http://localhost/api/identity/members", {
          headers: headers(key.secret),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await backend.app.request("http://localhost/api/host/models", {
          method: "POST",
          headers: headers(key.secret, true),
          body: JSON.stringify({ id: "forbidden", baseUrl: "http://unused", modelIds: ["x"] }),
        })
      ).status,
    ).toBe(403);
  });

  test("keeps slugs immutable, redacts member routes, and preserves exact legacy visibility during migration", async () => {
    const { backend } = await fixture();
    const owner = await setupOwner(backend);
    const member = await register(backend, owner.token, "member_user");
    expect(
      (
        await backend.app.request("http://localhost/api/host/models", {
          method: "POST",
          headers: headers(owner.token, true),
          body: JSON.stringify({
            id: "shared-backend",
            label: "Secret endpoint",
            baseUrl: "https://private.example/v1",
            apiKey: "never-return-this",
            modelIds: ["allowed-model", "hidden-model"],
          }),
        })
      ).status,
    ).toBe(200);
    await backend.app.request(
      "http://localhost/api/identity/model-connections/shared-backend/entitlements",
      {
        method: "PUT",
        headers: headers(owner.token, true),
        body: JSON.stringify({
          entitlements: [
            { subjectType: "user", subjectId: member.actor.id, modelId: "allowed-model" },
          ],
        }),
      },
    );

    const legacy = await value<Array<Record<string, unknown>>>(
      await backend.app.request("http://localhost/api/host/models", {
        headers: headers(member.token),
      }),
    );
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({ id: "shared-backend", modelIds: ["allowed-model"] });
    expect(legacy[0]).not.toHaveProperty("baseUrl");
    expect(JSON.stringify(legacy)).not.toContain("hidden-model");
    expect(JSON.stringify(legacy)).not.toContain("private.example");

    const created = await backend.app.request("http://localhost/api/identity/model-offerings", {
      method: "POST",
      headers: headers(owner.token, true),
      body: JSON.stringify({
        id: "company-model",
        displayName: "Company Model",
        backendId: "shared-backend",
        upstreamModelId: "hidden-model",
      }),
    });
    expect(created.status).toBe(200);
    expect(
      (
        await backend.app.request("http://localhost/api/identity/model-offerings", {
          method: "POST",
          headers: headers(owner.token, true),
          body: JSON.stringify({
            id: "company-model",
            displayName: "Replacement",
            backendId: "shared-backend",
            upstreamModelId: "allowed-model",
          }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await backend.app.request("http://localhost/api/identity/model-offerings/company-model", {
          method: "PUT",
          headers: headers(owner.token, true),
          body: JSON.stringify({
            id: "renamed-model",
            displayName: "Renamed",
            backendId: "shared-backend",
            upstreamModelId: "allowed-model",
          }),
        })
      ).status,
    ).toBe(400);
    await backend.app.request(
      "http://localhost/api/identity/model-offerings/company-model/entitlements",
      {
        method: "PUT",
        headers: headers(owner.token, true),
        body: JSON.stringify({
          entitlements: [{ subjectType: "user", subjectId: member.actor.id }],
        }),
      },
    );
    const offerings = await value<Array<Record<string, unknown>>>(
      await backend.app.request("http://localhost/api/host/model-offerings", {
        headers: headers(member.token),
      }),
    );
    expect(offerings).toContainEqual(
      expect.objectContaining({ id: "company-model", displayName: "Company Model" }),
    );
    const company = offerings.find((offering) => offering.id === "company-model")!;
    expect(company).not.toHaveProperty("backendId");
    expect(company).not.toHaveProperty("upstreamModelId");

    // Re-running migration is idempotent and cannot widen the exact legacy grant.
    await backend.app.request("http://localhost/api/host/models", {
      headers: headers(member.token),
    });
    const after = await value<Array<{ modelIds: string[] }>>(
      await backend.app.request("http://localhost/api/host/models", {
        headers: headers(member.token),
      }),
    );
    expect(after[0]?.modelIds).toEqual(["allowed-model"]);
  });

  test("resolves an entitled offering for the current actor and permits a direct-user run share only on shared models", async () => {
    const { backend, project, requests } = await fixture();
    const owner = await setupOwner(backend);
    const member = await register(backend, owner.token, "runner_user");
    await backend.app.request(`/api/identity/members/${member.actor.id}/path-grants`, {
      method: "PUT",
      headers: headers(owner.token, true),
      body: JSON.stringify({ grants: [{ root: project, access: "write" }] }),
    });
    await backend.app.request("/api/host/models", {
      method: "POST",
      headers: headers(owner.token, true),
      body: JSON.stringify({
        id: "shared",
        baseUrl: "http://unused",
        modelIds: ["upstream-exact"],
      }),
    });
    await backend.app.request("/api/identity/model-offerings", {
      method: "POST",
      headers: headers(owner.token, true),
      body: JSON.stringify({
        id: "friendly",
        displayName: "Friendly",
        backendId: "shared",
        upstreamModelId: "upstream-exact",
      }),
    });
    await backend.app.request("/api/identity/model-offerings/friendly/entitlements", {
      method: "PUT",
      headers: headers(owner.token, true),
      body: JSON.stringify({ entitlements: [{ subjectType: "user", subjectId: member.actor.id }] }),
    });
    const session = await value<{ id: string }>(
      await backend.app.request("/api/host/sessions", {
        method: "POST",
        headers: headers(owner.token, true),
        body: JSON.stringify({
          directory: project,
          model: { connectionId: "opengui-offering", modelId: "friendly" },
          reasoning: "none",
        }),
      }),
    );
    expect(
      (
        await backend.app.request(`/api/identity/sessions/${session.id}/shares`, {
          method: "POST",
          headers: headers(owner.token, true),
          body: JSON.stringify({ granteeType: "user", granteeId: member.actor.id, role: "run" }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await backend.app.request(`/api/host/sessions/${session.id}/prompt`, {
          method: "POST",
          headers: headers(member.token, true),
          body: JSON.stringify({ text: "run directly" }),
        })
      ).status,
    ).toBe(200);
    await (
      await backend.hostReady
    ).waitForIdle(session.id, { type: "user", id: member.actor.id, displayName: "runner_user" });
    expect(
      requests.at(-1)?.context.findLast((item) => item.type === "user_message")?.model,
    ).toEqual({ connectionId: "shared", modelId: "upstream-exact" });
    expect(requests.at(-1)?.actor?.id).toBe(member.actor.id);

    await backend.app.request("/api/host/models", {
      method: "POST",
      headers: headers(member.token, true),
      body: JSON.stringify({
        id: "personal",
        plane: "user",
        baseUrl: "http://unused",
        modelIds: ["private"],
      }),
    });
    const personal = await value<{ id: string }>(
      await backend.app.request("/api/host/sessions", {
        method: "POST",
        headers: headers(member.token, true),
        body: JSON.stringify({
          directory: project,
          model: { connectionId: "personal", modelId: "private" },
          reasoning: "none",
        }),
      }),
    );
    expect(
      (
        await backend.app.request(`/api/identity/sessions/${personal.id}/shares`, {
          method: "POST",
          headers: headers(member.token, true),
          body: JSON.stringify({ granteeType: "user", granteeId: owner.actor.id, role: "run" }),
        })
      ).status,
    ).toBe(400);
    const ownerOfferings = await value<Array<{ backendId?: string }>>(
      await backend.app.request("/api/host/model-offerings", { headers: headers(owner.token) }),
    );
    expect(ownerOfferings.some((offering) => offering.backendId === "personal")).toBe(false);
  });
});
