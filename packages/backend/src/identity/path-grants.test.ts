import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { IdentityService } from "./identity.ts";
import type { Actor } from "./types.ts";
import { createEnforcedPolicyResolver } from "../path-policy/enforcement.ts";

const databases: DatabaseSync[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Identity path grants", () => {
  test("atomically replaces grants and builds deny-by-default member policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-identity-grants-"));
    temporaryDirectories.push(root);
    const granted = join(root, "granted");
    const ungranted = join(root, "ungranted");
    await Promise.all([mkdir(granted), mkdir(ungranted)]);
    await writeFile(join(granted, "file.txt"), "safe");

    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const identity = new IdentityService({
      database,
      secret: "path-grant-test-secret-that-is-at-least-32-characters",
      pathGrantsMode: "enforced",
      allowedRoots: [root],
    });
    await identity.ready;
    database
      .prepare(
        "INSERT INTO host_membership (user_id, team_id, role, created_at) VALUES (?, 'host_default', ?, ?)",
      )
      .run("owner", "owner", Date.now());
    database
      .prepare(
        "INSERT INTO host_membership (user_id, team_id, role, created_at) VALUES (?, 'host_default', ?, ?)",
      )
      .run("member", "member", Date.now());
    const owner: Actor = {
      type: "user",
      id: "owner",
      displayName: "owner",
      role: "owner",
    };
    const member: Actor = {
      type: "user",
      id: "member",
      displayName: "member",
      role: "member",
    };
    await expect(
      identity.replacePathGrants(
        { type: "api_key", id: "owner-key", displayName: "owner key", role: "owner" },
        "user",
        member.id,
        [],
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    const replaced = await identity.replacePathGrants(owner, "user", member.id, [
      { root: granted, access: "write" },
    ]);
    expect(replaced).toMatchObject({ revision: 1, grants: [{ root: granted, access: "write" }] });
    const policy = await identity.effectivePathPolicy(member);
    expect(policy).toMatchObject({ revision: 1, restricted: true, shellAllowed: false });
    expect((await policy.authorizePath(join(granted, "file.txt"), "read")).allowed).toBe(true);
    expect((await policy.authorizePath(ungranted, "read")).allowed).toBe(false);

    const cleared = await identity.replacePathGrants(owner, "user", member.id, []);
    expect(cleared).toMatchObject({ revision: 2, grants: [] });
    expect(database.prepare("SELECT COUNT(*) AS count FROM host_path_grant").get()).toMatchObject({
      count: 0,
    });
  });

  test("owner and local actors remain unrestricted when enforcement is enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-owner-policy-"));
    temporaryDirectories.push(root);
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const identity = new IdentityService({
      database,
      secret: "owner-policy-test-secret-that-is-at-least-32-characters",
      pathGrantsMode: "enforced",
      allowedRoots: [root],
    });
    await identity.ready;
    for (const actor of [
      { type: "user", id: "owner", displayName: "owner", role: "owner" },
      { type: "api_key", id: "key", displayName: "key", role: "owner" },
      { type: "local", id: "local", displayName: "local", role: "owner" },
    ] as Actor[]) {
      expect(await identity.pathPolicyStatus(actor)).toMatchObject({
        mode: "enforced",
        restricted: false,
        foundationReady: true,
        enforcementReady: true,
      });
    }
  });

  test("rehydrates API-key role and grants by durable id and fails closed after revocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-key-policy-"));
    temporaryDirectories.push(root);
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const identity = new IdentityService({
      database,
      secret: "key-policy-test-secret-that-is-at-least-32-characters",
      pathGrantsMode: "enforced",
      allowedRoots: [root],
    });
    await identity.ready;
    database
      .prepare(
        "INSERT INTO host_membership (user_id, team_id, role, created_at) VALUES ('owner', 'host_default', 'owner', ?)",
      )
      .run(Date.now());
    database
      .prepare(
        `INSERT INTO host_api_key
          (id, label, secret_hash, role, created_by_user_id, created_at)
         VALUES ('member-key', 'Current label', 'hash', 'member', 'owner', ?)`,
      )
      .run(Date.now());
    const owner: Actor = { type: "user", id: "owner", displayName: "Owner", role: "owner" };
    await identity.replacePathGrants(owner, "api_key", "member-key", [{ root, access: "read" }]);
    const resolvePolicy = createEnforcedPolicyResolver(identity);
    const policy = await resolvePolicy({
      type: "api_key",
      id: "member-key",
      displayName: "Untrusted durable label",
    });
    expect(policy).toMatchObject({ restricted: true, shellAllowed: false });
    expect((await policy.authorizePath(root, "read")).allowed).toBe(true);

    await identity.revokeApiKey(owner, "member-key");
    await expect(identity.listPathGrants(owner, "api_key", "member-key")).rejects.toMatchObject({
      code: "GRANT_SUBJECT_NOT_FOUND",
    });
    await expect(
      identity.replacePathGrants(owner, "api_key", "member-key", [{ root, access: "read" }]),
    ).rejects.toMatchObject({ code: "GRANT_SUBJECT_NOT_FOUND" });
    await expect(
      resolvePolicy({ type: "api_key", id: "member-key", displayName: "Old label" }),
    ).rejects.toThrow("Path not authorized");

    database
      .prepare(
        `INSERT INTO host_api_key
          (id, label, secret_hash, role, created_by_user_id, created_at, expires_at)
         VALUES ('expired-key', 'Expired', 'expired-hash', 'member', 'owner', ?, ?)`,
      )
      .run(Date.now() - 2, Date.now() - 1);
    await expect(identity.listPathGrants(owner, "api_key", "expired-key")).rejects.toMatchObject({
      code: "GRANT_SUBJECT_NOT_FOUND",
    });
  });
});
