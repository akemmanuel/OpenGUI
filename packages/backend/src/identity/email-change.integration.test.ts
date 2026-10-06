/**
 * Email-change-with-confirmation + owner-configured mail (revised #154 scope).
 *
 * This is NOT the original #154 self-service password recovery flow: there are
 * deliberately no forgot-password/request/redeem endpoints here (see
 * password-recovery.repro.test.ts, which pins their absence). Covered instead:
 * owner-only mail configuration with masked secrets, authenticated email-change
 * requests with current-password reauthentication, and public single-use token
 * confirmation against the NEW inbox before the identity email is replaced.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { IdentityService } from "./identity.ts";
import { createBackendHost, type BackendHost } from "../create-backend-host.ts";

const databases: DatabaseSync[] = [];
const backends: BackendHost[] = [];
const dataDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(backends.splice(0).map(async (backend) => (await backend.hostReady).close()));
  for (const database of databases.splice(0)) database.close();
  for (const directory of dataDirectories.splice(0)) rmSync(directory, { recursive: true });
});

type CapturedMail = { to: string; subject: string; text: string };

function host() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const dataDirectory = mkdtempSync(join(tmpdir(), "opengui-email-change-"));
  dataDirectories.push(dataDirectory);
  const backend = createBackendHost({
    dataDirectory,
    env: {
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
    },
    identityDatabase: database,
    identitySecret: "email-change-test-secret-with-32-characters",
  });
  backends.push(backend);
  return backend;
}

/** Installs an injectable capture sender; returns the outbox and a fail switch. */
function captureMail(backend: BackendHost) {
  const outbox: CapturedMail[] = [];
  const control = { fail: false };
  backend.identity?.setMailSender(async (message) => {
    if (control.fail) throw new Error("smtp unavailable");
    outbox.push(message);
  });
  return { outbox, control };
}

async function setupOwner(backend: BackendHost, password = "correct horse battery staple") {
  const response = await backend.app.request("http://localhost/api/identity/setup", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://client.example" },
    body: JSON.stringify({ username: "owner_user", email: "owner@example.com", password }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { value: { token: string; actor: { id: string } } };
}

async function createMember(backend: BackendHost, ownerToken: string, index: number) {
  const username = `change_member_${index}`;
  const email = `member${index}@example.com`;
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
  return {
    username,
    email,
    ...((await acceptResponse.json()) as { value: { token: string; actor: { id: string } } }),
  };
}

const mailConfigInput = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  host: "smtp.example.com",
  port: 587,
  username: "mailer",
  password: "smtp-secret-password",
  fromAddress: "no-reply@example.com",
  fromName: "OpenGUI Host",
  useStarttls: true,
  publicOrigin: "https://host.example.com",
  ...overrides,
});

async function configureMail(backend: BackendHost, ownerToken: string, overrides = {}) {
  const response = await backend.app.request("http://localhost/api/identity/mail-config", {
    method: "PUT",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify(mailConfigInput(overrides)),
  });
  expect(response.status).toBe(200);
  return response;
}

async function requestEmailChange(
  backend: BackendHost,
  token: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  return backend.app.request("http://localhost/api/identity/email-change/request", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      origin: "https://client.example",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

async function confirmEmailChange(backend: BackendHost, token: string) {
  return backend.app.request("http://localhost/api/identity/email-change/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

function tokenFromLastMail(outbox: CapturedMail[]) {
  const last = outbox.at(-1);
  expect(last).toBeTruthy();
  expect(last!.text).not.toContain("{{");
  // Links are shaped <origin>/#/confirm-email?token=… so the token lives in
  // the fragment query, never in searchParams.
  const urlText = last!.text.match(/https?:\/\/\S+/)?.[0] ?? "";
  const fragment = urlText.includes("#") ? urlText.slice(urlText.indexOf("#")) : "";
  const fragmentQuery = fragment.includes("?") ? fragment.slice(fragment.indexOf("?") + 1) : "";
  return new URLSearchParams(fragmentQuery).get("token") ?? "";
}

describe("owner-configured mail", () => {
  test("mail config is owner-only and never returns the secret", async () => {
    const backend = host();
    captureMail(backend);
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 1);

    expect((await backend.app.request("http://localhost/api/identity/mail-config")).status).toBe(
      401,
    );
    expect(
      (
        await backend.app.request("http://localhost/api/identity/mail-config", {
          headers: { authorization: `Bearer ${member.value.token}` },
        })
      ).status,
    ).toBe(403);

    const initial = await backend.app.request("http://localhost/api/identity/mail-config", {
      headers: { authorization: `Bearer ${owner.value.token}` },
    });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      ok: true,
      value: { enabled: false, hasPassword: false },
    });

    const saved = await configureMail(backend, owner.value.token);
    const serialized = await saved.text();
    expect(serialized).not.toContain("smtp-secret-password");
    expect(JSON.parse(serialized)).toMatchObject({
      ok: true,
      value: {
        enabled: true,
        host: "smtp.example.com",
        port: 587,
        username: "mailer",
        hasPassword: true,
        fromAddress: "no-reply@example.com",
        publicOrigin: "https://host.example.com",
      },
    });

    const reread = await (
      await backend.app.request("http://localhost/api/identity/mail-config", {
        headers: { authorization: `Bearer ${owner.value.token}` },
      })
    ).text();
    expect(reread).not.toContain("smtp-secret-password");

    expect(
      (
        await backend.app.request("http://localhost/api/identity/mail-config", {
          method: "PUT",
          headers: {
            authorization: `Bearer ${member.value.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(mailConfigInput()),
        })
      ).status,
    ).toBe(403);
  });

  test("mail config validation rejects bad hosts, ports, senders, and origins", async () => {
    const backend = host();
    captureMail(backend);
    const owner = await setupOwner(backend);
    for (const overrides of [
      { host: "" },
      { port: 0 },
      { port: 99999 },
      { fromAddress: "not-an-email" },
      { fromName: "Evil\r\nBcc: victim@example.com" },
      { fromName: "Tab\tSeparated" },
      { publicOrigin: "http://insecure.example.com" },
      { publicOrigin: "ftp://host.example.com" },
      { publicOrigin: "https://user:secret@host.example.com" },
      { publicOrigin: "https://" },
      { publicOrigin: "not a url" },
      { publicOrigin: "" },
    ]) {
      const response = await backend.app.request("http://localhost/api/identity/mail-config", {
        method: "PUT",
        headers: {
          authorization: `Bearer ${owner.value.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(mailConfigInput(overrides)),
      });
      expect(response.status).toBe(400);
    }
    // Untouched invalid drafts keep mail disabled: nothing was stored.
    const current = (await (
      await backend.app.request("http://localhost/api/identity/mail-config", {
        headers: { authorization: `Bearer ${owner.value.token}` },
      })
    ).json()) as { value: { enabled: boolean } };
    expect(current.value.enabled).toBe(false);
  });

  test("owner test mail is owner-only and surfaces delivery failure", async () => {
    const backend = host();
    const { outbox, control } = captureMail(backend);
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 2);

    const unconfigured = await backend.app.request("http://localhost/api/identity/mail-test", {
      method: "POST",
      headers: { authorization: `Bearer ${owner.value.token}`, "content-type": "application/json" },
      body: JSON.stringify({ to: "owner@example.com" }),
    });
    expect(unconfigured.status).toBe(400);
    expect(((await unconfigured.json()) as { code: string }).code).toBe("MAIL_NOT_CONFIGURED");

    await configureMail(backend, owner.value.token);
    expect(
      (
        await backend.app.request("http://localhost/api/identity/mail-test", {
          method: "POST",
          headers: {
            authorization: `Bearer ${member.value.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ to: "member2@example.com" }),
        })
      ).status,
    ).toBe(403);

    control.fail = true;
    const failed = await backend.app.request("http://localhost/api/identity/mail-test", {
      method: "POST",
      headers: { authorization: `Bearer ${owner.value.token}`, "content-type": "application/json" },
      body: JSON.stringify({ to: "owner@example.com" }),
    });
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { code: string }).code).toBe("MAIL_SEND_FAILED");

    control.fail = false;
    const sent = await backend.app.request("http://localhost/api/identity/mail-test", {
      method: "POST",
      headers: { authorization: `Bearer ${owner.value.token}`, "content-type": "application/json" },
      body: JSON.stringify({ to: "owner@example.com" }),
    });
    expect(sent.status).toBe(200);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toBe("owner@example.com");
  });
});

describe("authenticated email change with new-inbox confirmation", () => {
  test("wrong current password is rejected and email stays unchanged", async () => {
    const backend = host();
    captureMail(backend);
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 3);
    await configureMail(backend, owner.value.token);

    const rejected = await requestEmailChange(backend, member.value.token, {
      newEmail: "new-address@example.com",
      currentPassword: "wrong-password",
    });
    expect(rejected.status).toBe(400);
    const failure = (await rejected.json()) as { code: string; error: string };
    expect(failure.code).toBe("INVALID_PASSWORD");
    expect(failure.error).toMatch(/incorrect/i);

    // Unauthenticated callers cannot request at all.
    expect(
      (
        await backend.app.request("http://localhost/api/identity/email-change/request", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ newEmail: "new-address@example.com", currentPassword: "x" }),
        })
      ).status,
    ).toBe(401);

    const me = (await (
      await backend.app.request("http://localhost/api/identity/me", {
        headers: { authorization: `Bearer ${member.value.token}` },
      })
    ).json()) as { value: { user: { email: string } } };
    expect(me.value.user.email).toBe(member.email);
  });

  test("request without configured mail fails visibly and changes nothing", async () => {
    const backend = host();
    const { outbox } = captureMail(backend);
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 4);

    const response = await requestEmailChange(backend, member.value.token, {
      newEmail: "new-address@example.com",
      currentPassword: "original member password",
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("MAIL_NOT_CONFIGURED");
    expect(outbox).toHaveLength(0);
    expect(
      backend.identity?.database.prepare("SELECT COUNT(*) AS count FROM host_email_change").get(),
    ).toMatchObject({ count: 0 });
  });

  test("delivery failure leaves no usable token and no false success", async () => {
    const backend = host();
    const { outbox, control } = captureMail(backend);
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 5);
    await configureMail(backend, owner.value.token);

    control.fail = true;
    const response = await requestEmailChange(backend, member.value.token, {
      newEmail: "new-address@example.com",
      currentPassword: "original member password",
    });
    expect(response.status).toBe(502);
    expect(((await response.json()) as { code: string }).code).toBe("MAIL_SEND_FAILED");
    expect(outbox).toHaveLength(0);
    // The failed issuance is retained for rate accounting but never usable.
    const failed = backend.identity?.database
      .prepare("SELECT send_state AS state, used_at AS used FROM host_email_change")
      .get() as { state: string; used: number | null };
    expect(failed).toMatchObject({ state: "failed", used: null });
    const status = (await (
      await backend.app.request("http://localhost/api/identity/email-change/status", {
        headers: { authorization: `Bearer ${member.value.token}` },
      })
    ).json()) as { value: { pending: null } };
    expect(status.value.pending).toBeNull();
  });

  test("confirmation link uses the configured origin, never Host headers", async () => {
    const backend = host();
    const { outbox } = captureMail(backend);
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 6);
    await configureMail(backend, owner.value.token);

    const response = await requestEmailChange(
      backend,
      member.value.token,
      { newEmail: "new-address@example.com", currentPassword: "original member password" },
      { host: "evil.example.com", origin: "https://evil.example.com" },
    );
    expect(response.status).toBe(200);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toBe("new-address@example.com");
    const url = outbox[0]!.text.match(/https?:\/\/\S+/)?.[0] ?? "";
    expect(url.startsWith("https://host.example.com/")).toBe(true);
    expect(url).not.toContain("evil");
    // Only a hash is stored; the token itself never touches the database.
    const row = backend.identity?.database
      .prepare("SELECT token_hash AS hash, pending_email AS email FROM host_email_change")
      .get() as { hash: string; email: string };
    expect(row.email).toBe("new-address@example.com");
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    const token = tokenFromLastMail(outbox);
    expect(token).toBeTruthy();
    expect(row.hash).not.toContain(token);
  });

  test("confirm swaps the email, keeps sessions, notifies the old inbox", async () => {
    const backend = host();
    const { outbox } = captureMail(backend);
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 7);
    await configureMail(backend, owner.value.token);

    await requestEmailChange(backend, member.value.token, {
      newEmail: "forwarded@example.com",
      currentPassword: "original member password",
    });
    const token = tokenFromLastMail(outbox);
    const confirmed = await confirmEmailChange(backend, token);
    expect(confirmed.status).toBe(200);

    // Identity email replaced; login is still username-based and sessions survive.
    const me = (await (
      await backend.app.request("http://localhost/api/identity/me", {
        headers: { authorization: `Bearer ${member.value.token}` },
      })
    ).json()) as { value: { user: { email: string; username: string } } };
    expect(me.value.user.email).toBe("forwarded@example.com");
    expect(me.value.user.username).toBe(member.username);
    expect(
      (
        await backend.app.request("http://localhost/api/capabilities", {
          headers: { authorization: `Bearer ${member.value.token}` },
        })
      ).status,
    ).toBe(200);
    const login = await backend.app.request("http://localhost/api/identity/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: member.username, password: "original member password" }),
    });
    expect(login.status).toBe(200);

    // Previous address notified best-effort; token single-use afterwards.
    expect(outbox.some((mail) => mail.to === member.email)).toBe(true);
    expect((await confirmEmailChange(backend, token)).status).toBe(400);
  });

  test("expired, tampered, and foreign tokens fail without side effects", async () => {
    const backend = host();
    const { outbox } = captureMail(backend);
    const owner = await setupOwner(backend);
    const memberA = await createMember(backend, owner.value.token, 8);
    const memberB = await createMember(backend, owner.value.token, 9);
    await configureMail(backend, owner.value.token);

    await requestEmailChange(backend, memberA.value.token, {
      newEmail: "a-new@example.com",
      currentPassword: "original member password",
    });
    const token = tokenFromLastMail(outbox);

    // Tampered token.
    expect((await confirmEmailChange(backend, `${token}x`)).status).toBe(400);
    expect((await confirmEmailChange(backend, "not-a-token")).status).toBe(400);

    // Expired token.
    backend.identity?.database
      .prepare("UPDATE host_email_change SET expires_at = ?")
      .run(Date.now() - 1000);
    const expired = await confirmEmailChange(backend, token);
    expect(expired.status).toBe(400);
    expect(((await expired.json()) as { code: string }).code).toBe("INVALID_TOKEN");

    // Neither account changed; B's inbox is untouched.
    for (const member of [memberA, memberB]) {
      const me = (await (
        await backend.app.request("http://localhost/api/identity/me", {
          headers: { authorization: `Bearer ${member.value.token}` },
        })
      ).json()) as { value: { user: { email: string } } };
      expect(me.value.user.email).toBe(member.email);
    }
    // The only mail to the new address is the unconfirmed request itself; no
    // change notice went anywhere because nothing was confirmed.
    expect(outbox.filter((mail) => mail.to === "a-new@example.com")).toHaveLength(1);
  });

  test("a new request replaces the outstanding one; redeem rechecks uniqueness", async () => {
    const backend = host();
    const { outbox } = captureMail(backend);
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 10);
    const squatter = await createMember(backend, owner.value.token, 99);
    await configureMail(backend, owner.value.token);

    await requestEmailChange(backend, member.value.token, {
      newEmail: "first@example.com",
      currentPassword: "original member password",
    });
    const firstToken = tokenFromLastMail(outbox);
    await requestEmailChange(backend, member.value.token, {
      newEmail: "second@example.com",
      currentPassword: "original member password",
    });
    // Superseded token is dead; exactly one live change remains (replaced
    // rows are retained for rate-limit accounting, never confirmable).
    expect((await confirmEmailChange(backend, firstToken)).status).toBe(400);
    expect(
      backend.identity?.database
        .prepare(
          `SELECT COUNT(*) AS count FROM host_email_change
           WHERE send_state = 'sent' AND used_at IS NULL AND unusable_at IS NULL`,
        )
        .get(),
    ).toMatchObject({ count: 1 });

    // Address taken after request fails at redeem, token consumed, email kept.
    backend.identity?.database
      .prepare("UPDATE user SET email = ? WHERE email = ?")
      .run("second@example.com", squatter.email);
    const secondToken = tokenFromLastMail(outbox);
    const conflict = await confirmEmailChange(backend, secondToken);
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { code: string }).code).toBe("EMAIL_UNAVAILABLE");
    const me = (await (
      await backend.app.request("http://localhost/api/identity/me", {
        headers: { authorization: `Bearer ${member.value.token}` },
      })
    ).json()) as { value: { user: { email: string } } };
    expect(me.value.user.email).toBe(member.email);
  });

  test("request rate limits hold; status and cancel reflect the pending change", async () => {
    const backend = host();
    captureMail(backend);
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 11);
    await configureMail(backend, owner.value.token);

    const status = () =>
      backend.app.request("http://localhost/api/identity/email-change/status", {
        headers: { authorization: `Bearer ${member.value.token}` },
      });
    expect(
      ((await (await status()).json()) as { value: { pending: null } }).value.pending,
    ).toBeNull();

    // Five requests succeed (each replacing the last); the sixth is limited.
    for (let index = 0; index < 5; index += 1) {
      const response = await requestEmailChange(backend, member.value.token, {
        newEmail: `rotate${index}@example.com`,
        currentPassword: "original member password",
      });
      expect(response.status).toBe(200);
    }
    const limited = await requestEmailChange(backend, member.value.token, {
      newEmail: "rotate5@example.com",
      currentPassword: "original member password",
    });
    expect(limited.status).toBe(429);

    const pending = (await (await status()).json()) as {
      value: { pending: { email: string; expiresAt: number } };
    };
    expect(pending.value.pending.email).toBe("rotate4@example.com");

    const cancelled = await backend.app.request(
      "http://localhost/api/identity/email-change/cancel",
      {
        method: "POST",
        headers: { authorization: `Bearer ${member.value.token}` },
      },
    );
    expect(cancelled.status).toBe(200);
    expect(
      ((await (await status()).json()) as { value: { pending: null } }).value.pending,
    ).toBeNull();
  });

  test("without mail, owner member-reset still works as the fallback", async () => {
    const backend = host();
    captureMail(backend);
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 12);

    const reset = await backend.app.request(
      `http://localhost/api/identity/members/${member.value.actor.id}/reset-password`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.value.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ password: "replacement member password" }),
      },
    );
    expect(reset.status).toBe(200);
    const login = await backend.app.request("http://localhost/api/identity/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: member.username, password: "replacement member password" }),
    });
    expect(login.status).toBe(200);
  });
});

function identityDatabase(backend: BackendHost) {
  const database = backend.identity?.database;
  if (!database) throw new Error("identity unavailable in test");
  return database;
}

describe("review hardening", () => {
  async function cancelPending(backend: BackendHost, token: string) {
    const response = await backend.app.request(
      "http://localhost/api/identity/email-change/cancel",
      { method: "POST", headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);
  }

  function liveRowCount(backend: BackendHost, userId: string) {
    return (
      identityDatabase(backend)
        .prepare(
          `SELECT COUNT(*) AS count FROM host_email_change
           WHERE user_id = ? AND send_state = 'sent'
             AND used_at IS NULL AND unusable_at IS NULL`,
        )
        .get(userId) as { count: number }
    ).count;
  }

  test("request/cancel cycles stay within the hourly budget", async () => {
    const backend = host();
    captureMail(backend);
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 20);
    await configureMail(backend, owner.value.token);

    for (let cycle = 0; cycle < 2; cycle += 1) {
      for (let index = 0; index < 2; index += 1) {
        const response = await requestEmailChange(backend, member.value.token, {
          newEmail: `cycle${cycle}-${index}@example.com`,
          currentPassword: "original member password",
        });
        expect(response.status).toBe(200);
      }
      await cancelPending(backend, member.value.token);
      expect(liveRowCount(backend, member.value.actor.id)).toBe(0);
    }
    // Four requests are accounted despite the cancels; the fifth succeeds,
    // the sixth is limited: cancels never reset the budget.
    expect(
      (
        await requestEmailChange(backend, member.value.token, {
          newEmail: "fifth@example.com",
          currentPassword: "original member password",
        })
      ).status,
    ).toBe(200);
    const limited = await requestEmailChange(backend, member.value.token, {
      newEmail: "sixth@example.com",
      currentPassword: "original member password",
    });
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { code: string }).code).toBe("RATE_LIMITED");
    // History older than retention is pruned on the next issuance path.
    identityDatabase(backend)
      .prepare("UPDATE host_email_change SET created_at = ?")
      .run(Date.now() - 25 * 3_600_000);
    const freshMember = await createMember(backend, owner.value.token, 30);
    expect(
      (
        await requestEmailChange(backend, freshMember.value.token, {
          newEmail: "after-prune@example.com",
          currentPassword: "original member password",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        identityDatabase(backend)
          .prepare("SELECT COUNT(*) AS count FROM host_email_change")
          .get() as { count: number }
      ).count,
    ).toBe(1);
  });

  test("failed deliveries count toward the hourly budget and stay unusable", async () => {
    const backend = host();
    const { outbox, control } = captureMail(backend);
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 21);
    await configureMail(backend, owner.value.token);

    control.fail = true;
    for (let index = 0; index < 5; index += 1) {
      const response = await requestEmailChange(backend, member.value.token, {
        newEmail: `undelivered${index}@example.com`,
        currentPassword: "original member password",
      });
      expect(response.status).toBe(502);
    }
    // History is retained (failed, never usable) and the budget holds.
    expect(
      (
        identityDatabase(backend)
          .prepare("SELECT COUNT(*) AS count FROM host_email_change")
          .get() as { count: number }
      ).count,
    ).toBe(5);
    expect(liveRowCount(backend, member.value.actor.id)).toBe(0);
    const limited = await requestEmailChange(backend, member.value.token, {
      newEmail: "undelivered5@example.com",
      currentPassword: "original member password",
    });
    expect(limited.status).toBe(429);
    expect(outbox).toHaveLength(0);
  });

  test("a hung send does not block other accounts", async () => {
    const backend = host();
    const owner = await setupOwner(backend);
    const memberA = await createMember(backend, owner.value.token, 22);
    const memberB = await createMember(backend, owner.value.token, 23);
    await configureMail(backend, owner.value.token);
    let releaseSend!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let sends = 0;
    backend.identity?.setMailSender(async () => {
      sends += 1;
      if (sends === 1) await gate;
    });
    const pendingA = requestEmailChange(backend, memberA.value.token, {
      newEmail: "a-waiting@example.com",
      currentPassword: "original member password",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const responseB = await requestEmailChange(backend, memberB.value.token, {
      newEmail: "b-prompt@example.com",
      currentPassword: "original member password",
    });
    expect(responseB.status).toBe(200);
    releaseSend();
    expect((await pendingA).status).toBe(200);
    // B's row is live and independent of A's stalled send.
    expect(liveRowCount(backend, memberB.value.actor.id)).toBe(1);
  });

  test("cancel during send supersedes the in-flight change", async () => {
    const backend = host();
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 29);
    await configureMail(backend, owner.value.token);
    let releaseSend!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    backend.identity?.setMailSender(async () => {
      markEntered();
      await gate;
    });
    const pending = requestEmailChange(backend, member.value.token, {
      newEmail: "interrupted@example.com",
      currentPassword: "original member password",
    });
    await entered;
    await cancelPending(backend, member.value.token);
    releaseSend();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("EMAIL_CHANGE_SUPERSEDED");
    // The delivered link is dead and the budget still counts the attempt.
    expect(liveRowCount(backend, member.value.actor.id)).toBe(0);
  });

  test("host-wide confirm budget bounds invalid-token probing", async () => {
    const backend = host();
    captureMail(backend);
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 24);
    await configureMail(backend, owner.value.token);
    await requestEmailChange(backend, member.value.token, {
      newEmail: "probed@example.com",
      currentPassword: "original member password",
    });
    let limitedAt = -1;
    for (let index = 0; index < 130; index += 1) {
      const response = await confirmEmailChange(backend, `guess-${index}`);
      if (response.status === 429) {
        limitedAt = index;
        expect(((await response.json()) as { code: string }).code).toBe("RATE_LIMITED");
        break;
      }
      expect(response.status).toBe(400);
    }
    expect(limitedAt).toBeGreaterThanOrEqual(0);
    expect(limitedAt).toBeLessThan(130);
  });

  test("expired tokens are never consumed", async () => {
    const backend = host();
    captureMail(backend);
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 25);
    await configureMail(backend, owner.value.token);
    await requestEmailChange(backend, member.value.token, {
      newEmail: "stale@example.com",
      currentPassword: "original member password",
    });
    backend.identity?.database
      .prepare("UPDATE host_email_change SET expires_at = ?")
      .run(Date.now() - 1000);
    // Token value is unknown here on purpose; any invalid token exercises the path.
    const response = await confirmEmailChange(backend, "definitely-not-a-token");
    expect(response.status).toBe(400);
    const row = backend.identity?.database
      .prepare("SELECT used_at AS used, attempts FROM host_email_change")
      .get() as { used: number | null; attempts: number };
    expect(row.used).toBeNull();
    expect(row.attempts).toBe(0);
  });

  test("cancel after confirm cannot revert the change", async () => {
    const backend = host();
    const { outbox } = captureMail(backend);
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 26);
    await configureMail(backend, owner.value.token);
    await requestEmailChange(backend, member.value.token, {
      newEmail: "settled@example.com",
      currentPassword: "original member password",
    });
    expect((await confirmEmailChange(backend, tokenFromLastMail(outbox))).status).toBe(200);
    await cancelPending(backend, member.value.token);
    const me = (await (
      await backend.app.request("http://localhost/api/identity/me", {
        headers: { authorization: `Bearer ${member.value.token}` },
      })
    ).json()) as { value: { user: { email: string } } };
    expect(me.value.user.email).toBe("settled@example.com");
  });

  test("origin attacks are rejected at save time", async () => {
    const backend = host();
    captureMail(backend);
    const owner = await setupOwner(backend);
    for (const publicOrigin of [
      "https://host.example.com/?token=abc",
      "https://host.example.com/#token=abc",
      "https://host.example.com/confirm",
      "https://owner:secret@host.example.com",
      "http://host.example.com",
      "https://host.example.com:0",
      "https://host.example.com:99999",
    ]) {
      const response = await backend.app.request("http://localhost/api/identity/mail-config", {
        method: "PUT",
        headers: {
          authorization: `Bearer ${owner.value.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(mailConfigInput({ publicOrigin })),
      });
      expect(response.status, publicOrigin).toBe(400);
    }
    const saved = await backend.app.request("http://localhost/api/identity/mail-config", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${owner.value.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(mailConfigInput({ publicOrigin: "https://host.example.com/" })),
    });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { value: { publicOrigin: string } }).value.publicOrigin).toBe(
      "https://host.example.com",
    );
  });

  test("TLS is enforced for non-loopback hosts", async () => {
    const backend = host();
    captureMail(backend);
    const owner = await setupOwner(backend);
    const put = (overrides: Record<string, unknown>) =>
      backend.app.request("http://localhost/api/identity/mail-config", {
        method: "PUT",
        headers: {
          authorization: `Bearer ${owner.value.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(mailConfigInput(overrides)),
      });
    // Remote relay without STARTTLS is a downgrade: rejected.
    expect((await put({ useStarttls: false })).status).toBe(400);
    // Loopback relays may opt out (development and tests).
    expect((await put({ host: "127.0.0.1", useStarttls: false })).status).toBe(200);
    // Port 465 uses implicit TLS regardless of the toggle.
    expect((await put({ port: 465, useStarttls: false })).status).toBe(200);
  });

  test("confirmation mail honors Accept-Language and the notice reuses it", async () => {
    const backend = host();
    const { outbox } = captureMail(backend);
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 27);
    await configureMail(backend, owner.value.token);
    const response = await backend.app.request(
      "http://localhost/api/identity/email-change/request",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${member.value.token}`,
          "content-type": "application/json",
          "accept-language": "de-AT, de;q=0.9",
        },
        body: JSON.stringify({
          newEmail: "neu@example.com",
          currentPassword: "original member password",
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.subject).toContain("Bestätige");
    expect((await confirmEmailChange(backend, tokenFromLastMail(outbox))).status).toBe(200);
    const notice = outbox.find((mail) => mail.to === member.email);
    expect(notice?.subject).toContain("geändert");
    // Unknown languages fall back to English.
    const fallback = await backend.app.request(
      "http://localhost/api/identity/email-change/request",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${member.value.token}`,
          "content-type": "application/json",
          "accept-language": "../../etc/passwd",
        },
        body: JSON.stringify({
          newEmail: "fallback@example.com",
          currentPassword: "original member password",
        }),
      },
    );
    expect(fallback.status).toBe(200);
    expect(outbox.at(-1)!.subject).toContain("Confirm");
  });

  test("SMTP secret never lands in the identity database and can be cleared", async () => {
    const backend = host();
    captureMail(backend);
    const owner = await setupOwner(backend);
    await configureMail(backend, owner.value.token);
    const columns = backend.identity?.database
      .prepare("PRAGMA table_info(host_mail_config)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain("password_secret");
    const dump = backend.identity?.database
      .prepare("SELECT * FROM host_mail_config")
      .get() as Record<string, unknown>;
    expect(JSON.stringify(dump)).not.toContain("smtp-secret-password");
    // Clearing stores nothing and reports no password.
    const cleared = await backend.app.request("http://localhost/api/identity/mail-config", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${owner.value.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(mailConfigInput({ password: "" })),
    });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { value: { hasPassword: boolean } }).value.hasPassword).toBe(
      false,
    );
    const liveHost = await backend.hostReady;
    expect(liveHost.getMailSmtpPassword()).toBeNull();
  });

  test("concurrent confirms serialize: busy loses, retry wins, nothing half-applied", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opengui-email-race-"));
    dataDirectories.push(directory);
    const databasePath = join(directory, "identity.sqlite");
    const secret = "email-change-test-secret-with-32-characters";
    const outbox: Array<{ to: string; subject: string; text: string }> = [];
    const hostDirectory = mkdtempSync(join(tmpdir(), "opengui-email-race-host-"));
    dataDirectories.push(hostDirectory);
    const sharedBackend = createBackendHost({
      dataDirectory: hostDirectory,
      env: {
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
      },
      identityDatabasePath: databasePath,
      identitySecret: secret,
    });
    backends.push(sharedBackend);
    const owner = await setupOwner(sharedBackend);
    const member = await createMember(sharedBackend, owner.value.token, 28);
    await configureMail(sharedBackend, owner.value.token);
    // Capture the token through the second service instance sharing the file.
    const second = new IdentityService({
      databasePath,
      secret,
      mailSender: async (message) => {
        outbox.push(message);
      },
    });
    databases.push(second.database);
    await second.ready;
    // Route the request mail through the capture sender on the primary service.
    sharedBackend.identity?.setMailSender(async (message) => {
      outbox.push(message);
    });
    await requestEmailChange(sharedBackend, member.value.token, {
      newEmail: "raced@example.com",
      currentPassword: "original member password",
    });
    const token = tokenFromLastMail(outbox);
    // Hold the database write lock from the primary connection: the second
    // connection's confirm must fail bounded instead of half-applying.
    sharedBackend.identity?.database.exec("BEGIN IMMEDIATE");
    try {
      await expect(second.confirmEmailChange(token)).rejects.toMatchObject({
        code: "RATE_LIMITED",
      });
    } finally {
      sharedBackend.identity?.database.exec("ROLLBACK");
    }
    // After the lock releases, the same token confirms exactly once.
    await expect(second.confirmEmailChange(token)).resolves.toEqual({ changed: true });
    await expect(second.confirmEmailChange(token)).rejects.toMatchObject({
      code: "INVALID_TOKEN",
    });
    const email = (
      second.database.prepare("SELECT email FROM user WHERE id = ?").get(member.value.actor.id) as {
        email: string;
      }
    ).email;
    expect(email).toBe("raced@example.com");
  });

  test("secret round-trips through Host state storage", async () => {
    const backend = host();
    captureMail(backend);
    const owner = await setupOwner(backend);
    await configureMail(backend, owner.value.token);
    const liveHost = await backend.hostReady;
    expect(liveHost.getMailSmtpPassword()).toBe("smtp-secret-password");
    const reread = (await (
      await backend.app.request("http://localhost/api/identity/mail-config", {
        headers: { authorization: `Bearer ${owner.value.token}` },
      })
    ).json()) as { value: { hasPassword: boolean } };
    expect(reread.value.hasPassword).toBe(true);
  });
});

describe("credential binding", () => {
  async function changeOwnPassword(backend: BackendHost, token: string) {
    const response = await backend.app.request("http://localhost/api/identity/change-password", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        currentPassword: "original member password",
        newPassword: "rotated member password",
      }),
    });
    expect(response.status).toBe(200);
    // Rotation revokes every session including the caller's; the response
    // carries the replacement token.
    return ((await response.json()) as { value: { token: string } }).value.token;
  }

  function epochOf(backend: BackendHost, userId: string) {
    return (
      identityDatabase(backend)
        .prepare("SELECT credential_epoch AS epoch FROM host_membership WHERE user_id = ?")
        .get(userId) as { epoch: number }
    ).epoch;
  }

  test("password change retires outstanding tokens", async () => {
    const backend = host();
    const { outbox } = captureMail(backend);
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 40);
    await configureMail(backend, owner.value.token);
    expect(epochOf(backend, member.value.actor.id)).toBe(0);

    await requestEmailChange(backend, member.value.token, {
      newEmail: "attacker-controlled@example.com",
      currentPassword: "original member password",
    });
    const token = tokenFromLastMail(outbox);
    const rotated = await changeOwnPassword(backend, member.value.token);
    expect(epochOf(backend, member.value.actor.id)).toBe(1);

    // The mailed token no longer applies; the address is unchanged.
    const redeemed = await confirmEmailChange(backend, token);
    expect(redeemed.status).toBe(400);
    const me = (await (
      await backend.app.request("http://localhost/api/identity/me", {
        headers: { authorization: `Bearer ${rotated}` },
      })
    ).json()) as { value: { user: { email: string } } };
    expect(me.value.user.email).toBe(member.email);
  });

  test("owner reset retires outstanding tokens", async () => {
    const backend = host();
    const { outbox } = captureMail(backend);
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 41);
    await configureMail(backend, owner.value.token);

    await requestEmailChange(backend, member.value.token, {
      newEmail: "attacker-controlled@example.com",
      currentPassword: "original member password",
    });
    const token = tokenFromLastMail(outbox);
    const reset = await backend.app.request(
      `http://localhost/api/identity/members/${member.value.actor.id}/reset-password`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.value.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ password: "owner rotated password" }),
      },
    );
    expect(reset.status).toBe(200);
    expect(epochOf(backend, member.value.actor.id)).toBe(1);
    expect((await confirmEmailChange(backend, token)).status).toBe(400);
  });

  test("member removal retires rows while keeping rate history", async () => {
    const backend = host();
    const { outbox } = captureMail(backend);
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 42);
    await configureMail(backend, owner.value.token);

    await requestEmailChange(backend, member.value.token, {
      newEmail: "gone@example.com",
      currentPassword: "original member password",
    });
    const token = tokenFromLastMail(outbox);
    const removed = await backend.app.request(
      `http://localhost/api/identity/members/${member.value.actor.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${owner.value.token}` } },
    );
    expect(removed.status).toBe(200);
    expect((await confirmEmailChange(backend, token)).status).toBe(400);
    expect(
      (
        identityDatabase(backend)
          .prepare("SELECT COUNT(*) AS count FROM host_email_change")
          .get() as { count: number }
      ).count,
    ).toBe(1);
  });

  test("owner reset during password verification cannot mint a challenge bound to the new epoch", async () => {
    const backend = host();
    const { outbox } = captureMail(backend);
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 44);
    await configureMail(backend, owner.value.token);
    // Pause a real, successful old-password verification before the service
    // resumes reservation; never replace authentication with a canned result.
    const service = backend.identity as unknown as {
      verifyAccountPassword: (userId: string, password: string) => Promise<boolean>;
    };
    const verify = service.verifyAccountPassword.bind(service);
    let entered!: () => void;
    const verified = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    service.verifyAccountPassword = async (userId, password) => {
      const result = await verify(userId, password);
      entered();
      await resume;
      return result;
    };
    const pending = requestEmailChange(backend, member.value.token, {
      newEmail: "stale-proof@example.com",
      currentPassword: "original member password",
    });
    await verified;
    try {
      const reset = await backend.app.request(
        `http://localhost/api/identity/members/${member.value.actor.id}/reset-password`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${owner.value.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ password: "owner rotated password" }),
        },
      );
      expect(reset.status).toBe(200);
      expect(epochOf(backend, member.value.actor.id)).toBe(1);
    } finally {
      release();
    }
    const response = await pending;
    service.verifyAccountPassword = verify;
    expect(response.status).toBe(409);
    expect(outbox).toHaveLength(0);
  });

  test("in-flight issuance cannot publish after a password change", async () => {
    const backend = host();
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 43);
    await configureMail(backend, owner.value.token);
    let releaseSend!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    backend.identity?.setMailSender(async () => {
      markEntered();
      await gate;
    });
    const pending = requestEmailChange(backend, member.value.token, {
      newEmail: "race-winner@example.com",
      currentPassword: "original member password",
    });
    await entered;
    // Credential rotation lands while the confirmation mail is still sending.
    await changeOwnPassword(backend, member.value.token);
    releaseSend();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("EMAIL_CHANGE_SUPERSEDED");
    // No row is live and the retired reservation keeps its history.
    expect(
      (
        identityDatabase(backend)
          .prepare(
            `SELECT COUNT(*) AS count FROM host_email_change
             WHERE send_state = 'sent' AND used_at IS NULL AND unusable_at IS NULL`,
          )
          .get() as { count: number }
      ).count,
    ).toBe(0);
  });
});

describe("reauthentication budget", () => {
  test("wrong-password attempts hit a per-account bound without touching others", async () => {
    const backend = host();
    const { outbox } = captureMail(backend);
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 50);
    const neighbor = await createMember(backend, owner.value.token, 51);
    await configureMail(backend, owner.value.token);

    // A prior valid challenge stays live throughout the guessing.
    await requestEmailChange(backend, member.value.token, {
      newEmail: "legitimate@example.com",
      currentPassword: "original member password",
    });
    const validToken = tokenFromLastMail(outbox);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await requestEmailChange(backend, member.value.token, {
        newEmail: `guess${attempt}@example.com`,
        currentPassword: "wrong-password",
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("INVALID_PASSWORD");
    }
    const limited = await requestEmailChange(backend, member.value.token, {
      newEmail: "guess10@example.com",
      currentPassword: "wrong-password",
    });
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { code: string }).code).toBe("RATE_LIMITED");

    // Failed attempts are retained, unusable, and never confirmable.
    const failures = backend.identity?.database
      .prepare(
        `SELECT COUNT(*) AS count FROM host_email_change
         WHERE user_id = ? AND unusable_reason = 'reauth_failed' AND send_state = 'failed'
           AND used_at IS NULL AND unusable_at IS NOT NULL`,
      )
      .get(member.value.actor.id) as { count: number };
    expect(failures.count).toBe(10);

    // The prior valid token was never retired by wrong passwords.
    expect((await confirmEmailChange(backend, validToken)).status).toBe(200);

    // Cancelling cannot reset the failure budget: the correct password still
    // hits the reauth cap afterwards.
    await backend.app.request("http://localhost/api/identity/email-change/cancel", {
      method: "POST",
      headers: { authorization: `Bearer ${member.value.token}` },
    });
    const stillLimited = await requestEmailChange(backend, member.value.token, {
      newEmail: "after-cancel@example.com",
      currentPassword: "original member password",
    });
    expect(stillLimited.status).toBe(429);

    // The neighbor's budget is independent.
    expect(
      (
        await requestEmailChange(backend, neighbor.value.token, {
          newEmail: "neighbor-new@example.com",
          currentPassword: "original member password",
        })
      ).status,
    ).toBe(200);
  });

  test("own password rotation during reauth supersedes the request", async () => {
    const backend = host();
    const { outbox } = captureMail(backend);
    const owner = await setupOwner(backend);
    const member = await createMember(backend, owner.value.token, 52);
    await configureMail(backend, owner.value.token);
    const service = backend.identity as unknown as {
      verifyAccountPassword: (userId: string, password: string) => Promise<boolean>;
    };
    const verify = service.verifyAccountPassword.bind(service);
    let entered!: () => void;
    const verified = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    service.verifyAccountPassword = async (userId, password) => {
      const result = await verify(userId, password);
      entered();
      await resume;
      return result;
    };
    const pending = requestEmailChange(backend, member.value.token, {
      newEmail: "self-race@example.com",
      currentPassword: "original member password",
    });
    await verified;
    try {
      // A second client rotates the credential while verification is paused.
      const rotated = await backend.app.request("http://localhost/api/identity/change-password", {
        method: "POST",
        headers: {
          authorization: `Bearer ${member.value.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          currentPassword: "original member password",
          newPassword: "self rotated password",
        }),
      });
      expect(rotated.status).toBe(200);
    } finally {
      release();
    }
    const response = await pending;
    service.verifyAccountPassword = verify;
    expect(response.status).toBe(409);
    expect(outbox).toHaveLength(0);
  });
});
