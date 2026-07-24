import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createBackendHost, type BackendHost } from "../create-backend-host.ts";
import type { BackendHostEnv } from "../host/env.ts";
import { IDENTITY_AUDIT_MAX_ENTRIES } from "./audit.ts";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function env(identityMode: BackendHostEnv["identityMode"], authToken = ""): BackendHostEnv {
  return {
    port: 0,
    hostname: "127.0.0.1",
    isProduction: true,
    serverMode: "api-only",
    servesFrontend: false,
    authToken,
    allowedCorsOrigin: "https://client.example",
    allowedRoots: ["/tmp"],
    uploadMaxFileBytes: 1024,
    uploadMaxBatchBytes: 2048,
    identityMode,
  };
}

function host(identityMode: BackendHostEnv["identityMode"] = "remote", authToken = "") {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  return createBackendHost({
    env: env(identityMode, authToken),
    identityDatabase: database,
    identitySecret: "identity-integration-test-secret-with-32-characters",
  });
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
  const body = (await response.json()) as { value: { token: string } };
  expect(response.status).toBe(201);
  return body.value.token;
}

describe("Host identity", () => {
  test("accepts exactly one concurrent owner setup", async () => {
    const backend = host();
    const setup = (username: string, email: string) =>
      backend.app.request("http://localhost/api/identity/setup", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://client.example" },
        body: JSON.stringify({
          username,
          email,
          password: "correct horse battery staple",
        }),
      });

    const responses = await Promise.all([
      setup("first_owner", "first@example.com"),
      setup("second_owner", "second@example.com"),
    ]);

    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([201, 409]);
    expect(
      backend.identity?.database
        .prepare("SELECT COUNT(*) AS count FROM host_membership WHERE role = 'owner'")
        .get(),
    ).toMatchObject({ count: 1 });
  });

  test("sets up one owner, logs in by username, and protects product APIs", async () => {
    const backend = host();

    expect((await backend.app.request("http://localhost/api/capabilities")).status).toBe(401);
    expect(await (await backend.app.request("http://localhost/api/health")).json()).toMatchObject({
      ok: true,
      identity: "setup",
      authRequired: true,
      value: { identity: "setup", authRequired: true },
    });
    const token = await setupOwner(backend);

    const secondSetup = await backend.app.request("http://localhost/api/identity/setup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://client.example" },
      body: JSON.stringify({
        username: "other_owner",
        email: "other@example.com",
        password: "another strong password",
      }),
    });
    expect(secondSetup.status).toBe(409);

    const authorized = await backend.app.request("http://localhost/api/capabilities", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authorized.status).toBe(200);

    const login = await backend.app.request("http://localhost/api/identity/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://client.example" },
      body: JSON.stringify({ username: "owner_user", password: "correct horse battery staple" }),
    });
    expect(login.status).toBe(200);
    const loginBody = (await login.json()) as {
      value: { token: string; actor: { role: string } };
    };
    expect(loginBody.value.actor.role).toBe("owner");

    const me = await backend.app.request("http://localhost/api/identity/me", {
      headers: { authorization: `Bearer ${loginBody.value.token}` },
    });
    expect(await me.json()).toMatchObject({
      ok: true,
      value: { actor: { type: "user", displayName: "owner_user", role: "owner" } },
    });

    const logout = await backend.app.request("http://localhost/api/identity/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${loginBody.value.token}` },
    });
    expect(logout.status).toBe(200);
    expect(
      (
        await backend.app.request("http://localhost/api/capabilities", {
          headers: { authorization: `Bearer ${loginBody.value.token}` },
        })
      ).status,
    ).toBe(401);
  });

  test("owner can mint a Host API key and legacy token is rejected after setup", async () => {
    const backend = host("remote", "legacy-secret");
    expect(
      (
        await backend.app.request("http://localhost/api/capabilities", {
          headers: { authorization: "Bearer legacy-secret" },
        })
      ).status,
    ).toBe(200);
    const ownerToken = await setupOwner(backend);

    expect(
      (
        await backend.app.request("http://localhost/api/capabilities", {
          headers: { authorization: "Bearer legacy-secret" },
        })
      ).status,
    ).toBe(401);

    const minted = await backend.app.request("http://localhost/api/identity/api-keys", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ label: "CI", role: "member" }),
    });
    expect(minted.status).toBe(201);
    const mintedBody = (await minted.json()) as { value: { id: string; secret: string } };
    expect(mintedBody.value.secret).toMatch(/^ogui_/);
    expect(
      backend.identity?.database.prepare("SELECT secret_hash FROM host_api_key").get(),
    ).not.toMatchObject({ secret_hash: mintedBody.value.secret });
    expect(
      (
        await backend.app.request("http://localhost/api/capabilities", {
          headers: { authorization: `Bearer ${mintedBody.value.secret}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await backend.app.request("http://localhost/api/host/models", {
          method: "POST",
          headers: {
            authorization: `Bearer ${mintedBody.value.secret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(403);

    const listed = await backend.app.request("http://localhost/api/identity/api-keys", {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const listedBody = await listed.json();
    expect(listedBody).toMatchObject({
      ok: true,
      value: [{ id: mintedBody.value.id, label: "CI", role: "member", revokedAt: null }],
    });
    expect(JSON.stringify(listedBody)).not.toContain(mintedBody.value.secret);

    const keyGrants = await backend.app.request(
      `http://localhost/api/identity/api-keys/${mintedBody.value.id}/path-grants`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${ownerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ grants: [{ root: "/tmp", access: "write" }] }),
      },
    );
    expect(keyGrants.status).toBe(200);

    const revoked = await backend.app.request(
      `http://localhost/api/identity/api-keys/${mintedBody.value.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${ownerToken}` } },
    );
    expect(revoked.status).toBe(200);
    expect(
      backend.identity?.database
        .prepare("SELECT COUNT(*) AS count FROM host_path_grant WHERE subject_id = ?")
        .get(mintedBody.value.id),
    ).toMatchObject({ count: 0 });
    expect(
      (
        await backend.app.request("http://localhost/api/capabilities", {
          headers: { authorization: `Bearer ${mintedBody.value.secret}` },
        })
      ).status,
    ).toBe(401);
  });

  test("invite is hashed, expiring, single-use, and creates a guarded member", async () => {
    const backend = host();
    const ownerToken = await setupOwner(backend);
    const invited = await backend.app.request("http://localhost/api/identity/invites", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: "member@example.com" }),
    });
    expect(invited.status).toBe(201);
    const invite = (await invited.json()) as { value: { id: string; token: string } };
    expect(
      backend.identity?.database
        .prepare("SELECT token_hash FROM host_invite WHERE id = ?")
        .get(invite.value.id),
    ).not.toMatchObject({ token_hash: invite.value.token });
    const pending = await backend.app.request("http://localhost/api/identity/invites", {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const pendingBody = (await pending.json()) as { value: Array<Record<string, unknown>> };
    expect(pendingBody.value).toEqual([
      expect.objectContaining({ id: invite.value.id, role: "member" }),
    ]);
    expect(pendingBody.value[0]).not.toHaveProperty("token");

    const accepted = await backend.app.request("http://localhost/api/identity/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: invite.value.token,
        username: "team_member",
        email: "member@example.com",
        password: "member password is sufficiently long",
      }),
    });
    expect(accepted.status).toBe(201);
    const member = (await accepted.json()) as {
      value: { token: string; actor: { id: string; role: string } };
    };
    expect(member.value.actor.role).toBe("member");
    expect(
      (
        await backend.app.request("http://localhost/api/capabilities", {
          headers: { authorization: `Bearer ${member.value.token}` },
        })
      ).status,
    ).toBe(200);

    const reused = await backend.app.request("http://localhost/api/identity/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: invite.value.token,
        username: "other_member",
        email: "member@example.com",
        password: "another sufficiently long password",
      }),
    });
    expect(reused.status).toBe(410);
    expect(await reused.json()).toMatchObject({ code: "INVITE_INVALID" });
    expect(
      await (
        await backend.app.request("http://localhost/api/identity/invites", {
          headers: { authorization: `Bearer ${ownerToken}` },
        })
      ).json(),
    ).toMatchObject({ value: [] });

    const memberList = await backend.app.request("http://localhost/api/identity/members", {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(await memberList.json()).toMatchObject({
      ok: true,
      value: [
        { username: "owner_user", role: "owner" },
        { username: "team_member", role: "member" },
      ],
    });
    const forbidden = await backend.app.request("http://localhost/api/identity/members", {
      headers: { authorization: `Bearer ${member.value.token}` },
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  test("invite revocation and expiry prevent acceptance", async () => {
    const backend = host();
    const ownerToken = await setupOwner(backend);
    const createInvite = async (email: string) => {
      const response = await backend.app.request("http://localhost/api/identity/invites", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ownerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ email }),
      });
      return (await response.json()) as { value: { id: string; token: string } };
    };
    const revokedInvite = await createInvite("revoked@example.com");
    expect(
      (
        await backend.app.request(
          `http://localhost/api/identity/invites/${revokedInvite.value.id}`,
          { method: "DELETE", headers: { authorization: `Bearer ${ownerToken}` } },
        )
      ).status,
    ).toBe(200);

    const expiredInvite = await createInvite("expired@example.com");
    backend.identity?.database
      .prepare("UPDATE host_invite SET expires_at = ? WHERE id = ?")
      .run(Date.now() - 1, expiredInvite.value.id);
    for (const invite of [revokedInvite.value, expiredInvite.value]) {
      const response = await backend.app.request("http://localhost/api/identity/invites/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: invite.token,
          username: "blocked_member",
          email: invite === revokedInvite.value ? "revoked@example.com" : "expired@example.com",
          password: "sufficiently long blocked password",
        }),
      });
      expect(response.status).toBe(410);
    }
    expect(
      await (
        await backend.app.request("http://localhost/api/identity/invites", {
          headers: { authorization: `Bearer ${ownerToken}` },
        })
      ).json(),
    ).toMatchObject({ value: [] });
    expect(
      (
        await backend.app.request(
          `http://localhost/api/identity/invites/${expiredInvite.value.id}`,
          { method: "DELETE", headers: { authorization: `Bearer ${ownerToken}` } },
        )
      ).status,
    ).toBe(404);
  });

  test("owner password reset and member removal revoke all member sessions", async () => {
    const backend = host();
    const ownerToken = await setupOwner(backend);
    const inviteResponse = await backend.app.request("http://localhost/api/identity/invites", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: "removable@example.com" }),
    });
    const invite = (await inviteResponse.json()) as { value: { token: string } };
    const acceptResponse = await backend.app.request(
      "http://localhost/api/identity/invites/accept",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: invite.value.token,
          username: "removable_member",
          email: "removable@example.com",
          password: "original member password",
        }),
      },
    );
    const accepted = (await acceptResponse.json()) as {
      value: { token: string; actor: { id: string } };
    };

    const reset = await backend.app.request(
      `http://localhost/api/identity/members/${accepted.value.actor.id}/reset-password`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${ownerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ password: "replacement member password" }),
      },
    );
    expect(reset.status).toBe(200);
    expect(
      (
        await backend.app.request("http://localhost/api/capabilities", {
          headers: { authorization: `Bearer ${accepted.value.token}` },
        })
      ).status,
    ).toBe(401);

    const login = await backend.app.request("http://localhost/api/identity/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "removable_member",
        password: "replacement member password",
      }),
    });
    expect(login.status).toBe(200);
    const newSession = (await login.json()) as { value: { token: string } };

    const grants = await backend.app.request(
      `http://localhost/api/identity/members/${accepted.value.actor.id}/path-grants`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${ownerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ grants: [{ root: "/tmp", access: "read" }] }),
      },
    );
    expect(grants.status).toBe(200);
    expect(await grants.json()).toMatchObject({
      ok: true,
      value: { revision: 1, grants: [{ root: "/tmp", access: "read" }] },
    });

    const removed = await backend.app.request(
      `http://localhost/api/identity/members/${accepted.value.actor.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${ownerToken}` } },
    );
    expect(removed.status).toBe(200);
    expect(
      backend.identity?.database
        .prepare("SELECT COUNT(*) AS count FROM host_path_grant WHERE subject_id = ?")
        .get(accepted.value.actor.id),
    ).toMatchObject({ count: 0 });
    expect(
      backend.identity?.database
        .prepare("SELECT value FROM host_identity_config WHERE key = 'path_policy_revision'")
        .get(),
    ).toMatchObject({ value: "2" });
    expect(
      (
        await backend.app.request("http://localhost/api/capabilities", {
          headers: { authorization: `Bearer ${newSession.value.token}` },
        })
      ).status,
    ).toBe(401);
  });

  test("audit is owner-user-only, paginated, bounded, and contains no credentials", async () => {
    const backend = host();
    const ownerPassword = "correct horse battery staple";
    const ownerToken = await setupOwner(backend);
    const failedPassword = "failed password must never be audited";
    const failedLogin = async (username: string) => {
      const response = await backend.app.request("http://localhost/api/identity/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer authorization-header-must-never-be-audited",
        },
        body: JSON.stringify({ username, password: failedPassword }),
      });
      return { status: response.status, body: await response.json() };
    };
    expect(await failedLogin("owner_user")).toEqual(await failedLogin("unknown_user"));
    expect(await failedLogin("unknown_user")).toMatchObject({
      status: 401,
      body: { code: "INVALID_CREDENTIALS", error: "Invalid username or password" },
    });

    const inviteResponse = await backend.app.request("http://localhost/api/identity/invites", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: "audit-member@example.com" }),
    });
    const invite = (await inviteResponse.json()) as { value: { token: string } };
    const memberPassword = "member password must never be audited";
    const acceptedResponse = await backend.app.request(
      "http://localhost/api/identity/invites/accept",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: invite.value.token,
          username: "audit_member",
          email: "audit-member@example.com",
          password: memberPassword,
        }),
      },
    );
    const member = (await acceptedResponse.json()) as {
      value: { token: string; actor: { id: string } };
    };

    const revokeInviteResponse = await backend.app.request(
      "http://localhost/api/identity/invites",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${ownerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: "revoked-audit@example.com" }),
      },
    );
    const revokedInvite = (await revokeInviteResponse.json()) as {
      value: { id: string; token: string };
    };
    await backend.app.request(`http://localhost/api/identity/invites/${revokedInvite.value.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    const replacementPassword = "replacement password must never be audited";
    expect(
      (
        await backend.app.request(
          `http://localhost/api/identity/members/${member.value.actor.id}/reset-password`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${ownerToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ password: replacementPassword }),
          },
        )
      ).status,
    ).toBe(200);
    const refreshedMemberLogin = await backend.app.request("http://localhost/api/identity/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "audit_member",
        password: replacementPassword,
      }),
    });
    const refreshedMember = (await refreshedMemberLogin.json()) as {
      value: { token: string };
    };

    const mintedResponse = await backend.app.request("http://localhost/api/identity/api-keys", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ label: "Audit automation", role: "member" }),
    });
    const minted = (await mintedResponse.json()) as { value: { id: string; secret: string } };

    for (const credential of [refreshedMember.value.token, minted.value.secret]) {
      const forbidden = await backend.app.request("http://localhost/api/identity/audit", {
        headers: { authorization: `Bearer ${credential}` },
      });
      expect(forbidden.status).toBe(403);
      expect(await forbidden.json()).toMatchObject({ code: "FORBIDDEN" });
    }

    await backend.app.request(`http://localhost/api/identity/api-keys/${minted.value.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    await backend.app.request(`http://localhost/api/identity/members/${member.value.actor.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    const firstPageResponse = await backend.app.request(
      "http://localhost/api/identity/audit?limit=3",
      { headers: { authorization: `Bearer ${ownerToken}` } },
    );
    expect(firstPageResponse.status).toBe(200);
    const firstPage = (await firstPageResponse.json()) as {
      value: {
        events: Array<{ id: number; eventType: string; timestamp: number }>;
        nextCursor: number;
      };
    };
    expect(firstPage.value.events).toHaveLength(3);
    expect(firstPage.value.events.every((event) => Number.isSafeInteger(event.timestamp))).toBe(
      true,
    );
    expect(firstPage.value.nextCursor).toBe(firstPage.value.events.at(-1)?.id);
    const secondPage = await (
      await backend.app.request(
        `http://localhost/api/identity/audit?limit=999&before=${firstPage.value.nextCursor}`,
        { headers: { authorization: `Bearer ${ownerToken}` } },
      )
    ).json();
    expect(secondPage).toMatchObject({ ok: true });

    const allAudit = await (
      await backend.app.request("http://localhost/api/identity/audit?limit=100", {
        headers: { authorization: `Bearer ${ownerToken}` },
      })
    ).json();
    const serializedAudit = JSON.stringify(allAudit);
    for (const eventType of [
      "auth.login_failed",
      "invite.created",
      "invite.revoked",
      "invite.accepted",
      "member.password_reset",
      "member.removed",
      "api_key.minted",
      "api_key.revoked",
    ]) {
      expect(serializedAudit).toContain(eventType);
    }
    for (const secret of [
      ownerPassword,
      ownerToken,
      failedPassword,
      memberPassword,
      replacementPassword,
      refreshedMember.value.token,
      invite.value.token,
      revokedInvite.value.token,
      minted.value.secret,
      "authorization-header-must-never-be-audited",
      "provider-credential-must-never-be-audited",
    ]) {
      expect(serializedAudit).not.toContain(secret);
      expect(
        JSON.stringify(
          backend.identity?.database.prepare("SELECT * FROM host_identity_audit").all(),
        ),
      ).not.toContain(secret);
    }

    const auditColumns = backend.identity?.database
      .prepare("PRAGMA table_info(host_identity_audit)")
      .all() as Array<{ name: string }>;
    expect(auditColumns.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(["password", "token", "secret", "headers", "credentials"]),
    );

    backend.identity?.database.exec(`
      WITH RECURSIVE sequence(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value <= ${IDENTITY_AUDIT_MAX_ENTRIES}
      )
      INSERT INTO host_identity_audit (event_type, occurred_at, actor_type)
      SELECT 'auth.login_failed', value, 'anonymous' FROM sequence;
    `);
    expect(
      backend.identity?.database.prepare("SELECT COUNT(*) AS count FROM host_identity_audit").get(),
    ).toMatchObject({ count: IDENTITY_AUDIT_MAX_ENTRIES });
  }, 15_000);

  test("Desktop Local Host bypasses Account identity", async () => {
    const backend = host("desktop-local");
    expect((await backend.app.request("http://localhost/api/capabilities")).status).toBe(200);
    const me = await backend.app.request("http://localhost/api/auth/me");
    expect(await me.json()).toMatchObject({
      ok: true,
      value: { actor: { type: "local", role: "owner" }, user: null },
    });
  });
});
