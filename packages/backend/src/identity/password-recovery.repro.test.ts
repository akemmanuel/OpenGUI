/**
 * Focused regression/reproducer coverage for issue #154 (self-service password recovery).
 *
 * Part A guards EXISTING behavior that the recovery proposal must not regress:
 * owner-operated member reset boundary, signed-in change validation, session
 * revocation, and credential-free audit.
 *
 * Part B documents the MISSING self-service flow: no unauthenticated
 * forgot-password/request/redeem endpoints exist. These assertions pin the
 * current gap; a future recovery PR must turn them green by adding the flow
 * (with token hashing, expiry, rate limits, and non-enumerating responses).
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createBackendHost, type BackendHost } from "../create-backend-host.ts";
import type { BackendHostEnv } from "../host/env.ts";

const databases: DatabaseSync[] = [];
const backends: BackendHost[] = [];
const dataDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(backends.splice(0).map(async (backend) => (await backend.hostReady).close()));
  for (const database of databases.splice(0)) database.close();
  for (const directory of dataDirectories.splice(0)) rmSync(directory, { recursive: true });
});

function host() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const dataDirectory = mkdtempSync(join(tmpdir(), "opengui-recovery-repro-"));
  dataDirectories.push(dataDirectory);
  const env: BackendHostEnv = {
    port: 0,
    hostname: "127.0.0.1",
    isProduction: true,
    serverMode: "api-only",
    servesFrontend: false,
    authToken: "",
    allowedCorsOrigin: "https://client.example",
    allowedRoots: ["/tmp"],
    uploadMaxFileBytes: 1024,
    uploadMaxBatchBytes: 2048,
    identityMode: "remote",
  };
  const backend = createBackendHost({
    dataDirectory,
    env,
    identityDatabase: database,
    identitySecret: "recovery-repro-test-secret-with-32-characters",
  });
  backends.push(backend);
  return backend;
}

async function setupOwner(backend: BackendHost) {
  const response = await backend.app.request("http://localhost/api/identity/setup", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://client.example" },
    body: JSON.stringify({
      username: "owner_user",
      email: "owner@example.com",
      password: "correct horse battery staple",
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { value: { token: string; actor: { id: string } } };
  return body.value;
}

async function createMember(
  backend: BackendHost,
  ownerToken: string,
  username: string,
  email: string,
) {
  const inviteResponse = await backend.app.request("http://localhost/api/identity/invites", {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  expect(inviteResponse.status).toBe(201);
  const invite = (await inviteResponse.json()) as { value: { token: string } };
  const acceptResponse = await backend.app.request("http://localhost/api/identity/invites/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: invite.value.token,
      username,
      email,
      password: "original member password",
    }),
  });
  expect(acceptResponse.status).toBe(201);
  return (await acceptResponse.json()) as {
    value: { token: string; actor: { id: string } };
  };
}

describe("password recovery state (#154)", () => {
  test("owner reset boundary: member cannot reset, owner-via-route is refused", async () => {
    const backend = host();
    const owner = await setupOwner(backend);
    const member = await createMember(
      backend,
      owner.token,
      "recovery_member",
      "member@example.com",
    );
    const other = await createMember(backend, owner.token, "other_member", "other@example.com");

    // A signed-in member must not reset another member's password.
    const memberReset = await backend.app.request(
      `http://localhost/api/identity/members/${other.value.actor.id}/reset-password`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${member.value.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ password: "attacker chosen password" }),
      },
    );
    expect(memberReset.status).toBe(403);

    // The owner route must refuse the owner account itself.
    const ownerSelfReset = await backend.app.request(
      `http://localhost/api/identity/members/${owner.actor.id}/reset-password`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
        body: JSON.stringify({ password: "owner replacement password" }),
      },
    );
    expect(ownerSelfReset.status).toBe(409);
    expect(((await ownerSelfReset.json()) as { code: string }).code).toBe(
      "OWNER_PASSWORD_RESET_FORBIDDEN",
    );
  });

  test("owner reset revokes member sessions, audit carries no credentials", async () => {
    const backend = host();
    const owner = await setupOwner(backend);
    const member = await createMember(
      backend,
      owner.token,
      "revoked_member",
      "revoked@example.com",
    );

    const replacement = "replacement member password";
    const reset = await backend.app.request(
      `http://localhost/api/identity/members/${member.value.actor.id}/reset-password`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
        body: JSON.stringify({ password: replacement }),
      },
    );
    expect(reset.status).toBe(200);

    // Old session is dead; old password no longer authenticates.
    expect(
      (
        await backend.app.request("http://localhost/api/capabilities", {
          headers: { authorization: `Bearer ${member.value.token}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await backend.app.request("http://localhost/api/identity/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username: "revoked_member",
            password: "original member password",
          }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await backend.app.request("http://localhost/api/identity/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "revoked_member", password: replacement }),
        })
      ).status,
    ).toBe(200);

    // Audit records the event but never the credential.
    const audit = await backend.app.request("http://localhost/api/identity/audit?limit=25", {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(audit.status).toBe(200);
    const serialized = await audit.text();
    expect(serialized).not.toContain(replacement);
    expect(serialized).not.toContain("original member password");
    expect(serialized).toContain("member.password_reset");
  });

  test("signed-in change requires the current password and validates length", async () => {
    const backend = host();
    const owner = await setupOwner(backend);
    const call = (body: object) =>
      backend.app.request("http://localhost/api/identity/change-password", {
        method: "POST",
        headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(
      (await call({ currentPassword: "wrong-password", newPassword: "new secure password" }))
        .status,
    ).toBe(400);
    expect(
      (
        await call({
          currentPassword: "correct horse battery staple",
          newPassword: "short",
        })
      ).status,
    ).toBe(400);
    // Unauthenticated callers cannot use the signed-in flow at all.
    expect(
      (
        await backend.app.request("http://localhost/api/identity/change-password", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            currentPassword: "correct horse battery staple",
            newPassword: "new secure password",
          }),
        })
      ).status,
    ).toBe(401);
  });

  test("self-service recovery endpoints do not exist yet", async () => {
    const backend = host();
    await setupOwner(backend);
    for (const [method, path, body] of [
      ["POST", "/api/identity/forgot-password", { email: "member@example.com" }],
      ["POST", "/api/identity/request-password-reset", { email: "member@example.com" }],
      [
        "POST",
        "/api/identity/reset-password",
        { token: "opaque-token", password: "new secure password" },
      ],
      [
        "POST",
        "/api/identity/password-reset/confirm",
        { token: "opaque-token", password: "new secure password" },
      ],
    ] as const) {
      const response = await backend.app.request(`http://localhost${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      // No public self-service route exists: unknown paths are rejected by
      // global auth (401) or fall through to 404. Either way no reset token
      // is issued and no password is changed.
      expect([401, 404]).toContain(response.status);
    }
  });
});
