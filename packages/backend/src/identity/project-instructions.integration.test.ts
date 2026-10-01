import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vite-plus/test";
import { createBackendHost } from "../create-backend-host.ts";
import { readBackendHostEnv } from "../host/env.ts";
import type { Actor } from "./types.ts";

async function value<T>(response: Response): Promise<T> {
  return ((await response.json()) as { value: T }).value;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

test("shared project text, private preferences, and per-project team edit permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengui-scoped-instructions-"));
  const project = join(root, "project");
  const other = join(root, "other");
  await mkdir(project);
  await mkdir(other);
  const backend = createBackendHost({
    dataDirectory: join(root, "data"),
    env: {
      ...readBackendHostEnv(),
      identityMode: "remote",
      pathGrantsMode: "enforced",
      allowedRoots: [root],
      authToken: "",
      servesFrontend: false,
    },
    identityDatabase: new DatabaseSync(":memory:"),
    identitySecret: "project-instructions-test-secret-at-least-32-characters",
    identityBaseURL: "http://localhost",
  });
  cleanups.push(async () => {
    await (await backend.hostReady).close();
    backend.identity!.database.close();
    await rm(root, { recursive: true, force: true });
  });
  await backend.ready;
  const request = (path: string, token: string, method = "GET", body?: unknown) =>
    backend.app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const setup = await request("/api/identity/setup", "", "POST", {
    username: "owner",
    email: "owner@example.com",
    password: "a sufficiently long owner password",
  });
  expect(setup.status).toBe(201);
  const owner = await value<{ token: string; actor: Actor }>(setup);
  await request("/api/identity/host-policy", owner.token, "PUT", { registrationMode: "open" });
  const register = async (username: string) => {
    const response = await request("/api/identity/register", "", "POST", {
      username,
      email: `${username}@example.com`,
      password: "a sufficiently long member password",
    });
    expect(response.status).toBe(201);
    return value<{ token: string; actor: Actor }>(response);
  };
  const alice = await register("alice");
  const bob = await register("bob");
  const grant = (userId: string, grants: Array<{ root: string; access: string }>) =>
    request(`/api/identity/members/${userId}/path-grants`, owner.token, "PUT", { grants });
  expect(
    (
      await grant(alice.actor.id, [
        { root: project, access: "read" },
        { root: other, access: "read" },
      ])
    ).status,
  ).toBe(200);
  expect((await grant(bob.actor.id, [{ root: project, access: "read" }])).status).toBe(200);
  const host = await backend.hostReady;
  await host.registerProject(project, owner.actor);
  await host.registerProject(other, owner.actor);
  const identity = backend.identity!;
  const team = await identity.saveTeam(owner.actor, {
    name: "Frontend",
    memberIds: [alice.actor.id],
    allowByok: true,
    allowByos: true,
  });
  const blockedTeam = await identity.saveTeam(owner.actor, {
    name: "Restricted",
    memberIds: [alice.actor.id],
    allowByok: true,
    allowByos: true,
  });
  const endpoint = `/api/host/project-instructions?directory=${encodeURIComponent(project)}`;
  const save = (token: string, directory = project, text = "Shared conventions") =>
    request("/api/host/project-instructions", token, "PUT", { directory, text });
  const toggle = (token: string, teamId: string, allowed: boolean) =>
    request("/api/host/project-instructions/editors", token, "PUT", {
      directory: project,
      teamId,
      allowed,
    });

  expect((await save(alice.token)).status).toBe(403);
  expect((await toggle(alice.token, team.id, true)).status).toBe(403);
  expect((await toggle(owner.token, "missing-team", true)).status).toBe(400);
  expect((await toggle(owner.token, blockedTeam.id, false)).status).toBe(200);
  expect((await toggle(owner.token, team.id, true)).status).toBe(200);
  expect((await save(alice.token)).status).toBe(200);
  expect((await save(alice.token, other)).status).toBe(403);
  expect((await save(bob.token)).status).toBe(403);
  const shared = await request(endpoint, bob.token);
  expect(shared.status).toBe(200);
  expect(await value(shared)).toMatchObject({
    text: "Shared conventions",
    canEdit: false,
    canManage: false,
    teams: [],
  });
  expect(
    (
      await request(
        `/api/host/project-instructions?directory=${encodeURIComponent(other)}`,
        bob.token,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request("/api/host/project-instructions", alice.token, "PUT", {
        directory: project,
        text: "x".repeat(32_001),
      })
    ).status,
  ).toBe(400);
  expect((await request("/api/host/project-instructions", owner.token, "PUT", null)).status).toBe(
    400,
  );

  expect(
    (
      await request("/api/host/personal-instructions", alice.token, "PUT", {
        text: "Alice private preferences",
        userId: bob.actor.id,
      })
    ).status,
  ).toBe(200);
  expect((await request("/api/host/personal-instructions", bob.token)).status).toBe(200);
  expect(await value(await request("/api/host/personal-instructions", bob.token))).toEqual({
    text: "",
  });
  expect(
    await value(
      await request(`/api/host/personal-instructions?userId=${alice.actor.id}`, owner.token),
    ),
  ).toEqual({ text: "" });

  // Viewer status always wins over a team allow. API credentials cannot edit or inherit preferences.
  await identity.setMemberRole(owner.actor, alice.actor.id, "viewer");
  expect((await save(alice.token)).status).toBe(403);
  await identity.setMemberRole(owner.actor, alice.actor.id, "member");
  await toggle(owner.token, team.id, false);
  expect((await save(alice.token)).status).toBe(403);
  await toggle(owner.token, team.id, true);
  await grant(alice.actor.id, []);
  expect((await save(alice.token)).status).toBe(403);
  await grant(alice.actor.id, [{ root: project, access: "read" }]);
  await identity.saveTeam(
    owner.actor,
    { name: team.name, memberIds: [], allowByok: true, allowByos: true },
    team.id,
  );
  expect((await save(alice.token)).status).toBe(403);
  expect((await save(owner.token)).status).toBe(200);
});
