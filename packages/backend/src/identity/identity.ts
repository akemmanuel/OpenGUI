import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin, bearer, username } from "better-auth/plugins";
import { adminAc } from "better-auth/plugins/admin/access";
import {
  canonicalizeAllowedRoots,
  canonicalizeGrantRoot,
  createEffectivePathPolicy,
  type EffectivePathPolicy,
  type PathGrantAccess,
} from "../path-policy/path-policy.ts";
import type { Actor, HostRole } from "./types.ts";
import type { DurableActor } from "@opengui/harness";
import { IdentityAuditLog, identityAuditEventTypes } from "./audit.ts";

const TEAM_ID = "host_default";
const API_KEY_PREFIX = "ogui_";

type MembershipRow = {
  user_id: string;
  role: HostRole;
  can_invite: number;
};

export type RegistrationMode = "invite_only" | "open";
export type SessionAccessRole = "view" | "run" | "admin" | "owner";
export type SessionAccessAction = "view" | "run" | "admin" | "delete";
export type ModelConnectionPlane = "host" | "team" | "user";
export type ModelCredentialKind = "byok" | "byos";

export type ModelConnectionAccess = {
  id: string;
  plane: ModelConnectionPlane;
  ownerType: "host" | "team" | "user";
  ownerId: string;
  credentialKind: ModelCredentialKind;
};

type ApiKeyRow = {
  id: string;
  label: string;
  role: HostRole;
};

type InviteRow = {
  id: string;
  email: string;
  created_by_user_id: string;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
  revoked_at: number | null;
};

export class IdentityError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type IdentityDatabase = DatabaseSync;

export type IdentityServiceOptions = {
  database?: IdentityDatabase;
  databasePath?: string;
  secret?: string;
  baseURL?: string;
  trustedOrigins?: string[];
  pathGrantsMode?: "disabled" | "enforced";
  allowedRoots?: string[];
};

function defaultDatabasePath() {
  const dataDir = resolve(
    process.env.OPENGUI_DATA_DIR || join(homedir(), ".config", "OpenGUI-web"),
  );
  return join(dataDir, "opengui-identity-v1.sqlite");
}

function hashSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

function jsonRequest(url: string, body: unknown, headers?: Headers) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/json");
  return new Request(url, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}

export class IdentityService {
  readonly database: IdentityDatabase;
  readonly auth;
  readonly ready: Promise<void>;
  private readonly authBaseURL: string;
  private readonly pathGrantsMode: "disabled" | "enforced";
  private readonly configuredAllowedRoots: string[];
  private readonly audit: IdentityAuditLog;
  private canonicalAllowedRoots?: Promise<string[]>;
  private setupQueue = Promise.resolve();
  private inviteAcceptQueue = Promise.resolve();

  constructor(options: IdentityServiceOptions = {}) {
    const databasePath = options.databasePath ?? defaultDatabasePath();
    if (!options.database) mkdirSync(dirname(databasePath), { recursive: true });
    this.database = options.database ?? new DatabaseSync(databasePath);
    this.audit = new IdentityAuditLog(this.database);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    const configuredPathGrantsMode =
      options.pathGrantsMode ?? process.env.OPENGUI_PATH_GRANTS?.trim().toLowerCase();
    this.pathGrantsMode = configuredPathGrantsMode === "enforced" ? "enforced" : "disabled";
    const configuredRoots =
      options.allowedRoots ?? (process.env.OPENGUI_ALLOWED_ROOTS || homedir()).split(",");
    this.configuredAllowedRoots = configuredRoots
      .map((root) => resolve(root.trim()))
      .filter(Boolean);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS host_identity_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const configuredSecret = options.secret ?? process.env.OPENGUI_AUTH_SECRET?.trim();
    let secret = configuredSecret;
    if (!secret) {
      const row = this.database
        .prepare("SELECT value FROM host_identity_config WHERE key = 'auth_secret'")
        .get() as { value: string } | undefined;
      secret = row?.value ?? randomBytes(32).toString("base64url");
      this.database
        .prepare(
          "INSERT OR IGNORE INTO host_identity_config (key, value) VALUES ('auth_secret', ?)",
        )
        .run(secret);
    }

    this.authBaseURL = (
      options.baseURL ??
      process.env.BETTER_AUTH_URL ??
      process.env.OPENGUI_BASE_URL ??
      "http://localhost"
    ).replace(/\/+$/, "");
    this.auth = betterAuth({
      database: this.database,
      secret,
      baseURL: this.authBaseURL,
      basePath: "/api/auth",
      trustedOrigins: options.trustedOrigins,
      emailAndPassword: { enabled: true },
      // Host authorization remains authoritative. The admin plugin is only used through
      // guarded server API calls below; Better Auth's admin HTTP routes are not mounted.
      plugins: [
        username(),
        bearer(),
        admin({ adminRoles: ["user", "admin"], roles: { user: adminAc, admin: adminAc } }),
      ],
    });
    this.ready = this.initialize();

    if (!options.database && databasePath !== ":memory:") {
      try {
        chmodSync(databasePath, 0o600);
      } catch {
        // The file may be created lazily on an unusual SQLite implementation.
      }
    }
  }

  private async initialize() {
    const { runMigrations } = await getMigrations(this.auth.options);
    await runMigrations();
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS host_membership (
        user_id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL DEFAULT '${TEAM_ID}',
        role TEXT NOT NULL,
        can_invite INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS host_single_owner
        ON host_membership(role) WHERE role = 'owner';
      CREATE TABLE IF NOT EXISTS host_api_key (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        secret_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS host_api_key_secret_hash ON host_api_key(secret_hash);
      CREATE TABLE IF NOT EXISTS host_invite (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_by_user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        accepted_at INTEGER,
        accepted_by_user_id TEXT,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS host_invite_token_hash ON host_invite(token_hash);
      CREATE INDEX IF NOT EXISTS host_invite_email ON host_invite(email);
      CREATE TABLE IF NOT EXISTS host_path_grant (
        subject_type TEXT NOT NULL CHECK(subject_type IN ('user', 'api_key')),
        subject_id TEXT NOT NULL,
        root_path TEXT NOT NULL,
        access TEXT NOT NULL CHECK(access IN ('read', 'write')),
        created_by_user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(subject_type, subject_id, root_path)
      );
      CREATE INDEX IF NOT EXISTS host_path_grant_subject
        ON host_path_grant(subject_type, subject_id);
      INSERT OR IGNORE INTO host_identity_config (key, value)
        VALUES ('path_policy_revision', '0');
      INSERT OR IGNORE INTO host_identity_config (key, value)
        VALUES ('registration_mode', 'invite_only');
      CREATE TABLE IF NOT EXISTS host_invite_path_grant (
        invite_id TEXT NOT NULL,
        root_path TEXT NOT NULL,
        access TEXT NOT NULL CHECK(access IN ('read', 'write')),
        PRIMARY KEY(invite_id, root_path),
        FOREIGN KEY(invite_id) REFERENCES host_invite(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS host_session_access (
        session_id TEXT PRIMARY KEY,
        owner_type TEXT NOT NULL CHECK(owner_type IN ('user', 'api_key')),
        owner_id TEXT NOT NULL,
        pinned_connection_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS host_session_access_owner
        ON host_session_access(owner_type, owner_id);
      CREATE TABLE IF NOT EXISTS host_session_share (
        session_id TEXT NOT NULL,
        grantee_type TEXT NOT NULL CHECK(grantee_type IN ('user', 'team')),
        grantee_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('view', 'run', 'admin')),
        created_by_user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, grantee_type, grantee_id),
        FOREIGN KEY(session_id) REFERENCES host_session_access(session_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS host_session_view_link (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_by_user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER,
        FOREIGN KEY(session_id) REFERENCES host_session_access(session_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS host_session_view_link_session
        ON host_session_view_link(session_id);
      CREATE TABLE IF NOT EXISTS host_model_connection (
        id TEXT PRIMARY KEY,
        plane TEXT NOT NULL CHECK(plane IN ('host', 'team', 'user')),
        owner_type TEXT NOT NULL CHECK(owner_type IN ('host', 'team', 'user')),
        owner_id TEXT NOT NULL,
        credential_kind TEXT NOT NULL CHECK(credential_kind IN ('byok', 'byos')),
        created_by_user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS host_model_connection_owner
        ON host_model_connection(owner_type, owner_id);
      CREATE TABLE IF NOT EXISTS host_model_entitlement (
        connection_id TEXT NOT NULL,
        subject_type TEXT NOT NULL CHECK(subject_type IN ('user', 'team')),
        subject_id TEXT NOT NULL,
        model_id TEXT NOT NULL DEFAULT '*',
        created_by_user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(connection_id, subject_type, subject_id, model_id),
        FOREIGN KEY(connection_id) REFERENCES host_model_connection(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS host_team_model_policy (
        team_id TEXT PRIMARY KEY,
        allow_byok INTEGER NOT NULL DEFAULT 1,
        allow_byos INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO host_team_model_policy (team_id, allow_byok, allow_byos, updated_at)
        VALUES ('${TEAM_ID}', 1, 1, 0);
      INSERT OR IGNORE INTO host_identity_config (key, value) VALUES ('allow_byok', '1');
      INSERT OR IGNORE INTO host_identity_config (key, value) VALUES ('allow_byos', '1');
    `);
    this.ensureMembershipCanInviteColumn();
    this.audit.initialize();
    if (this.pathGrantsMode === "enforced") await this.getAllowedRoots();
  }

  private ensureMembershipCanInviteColumn() {
    const columns = this.database.prepare("PRAGMA table_info(host_membership)").all() as Array<{
      name: string;
    }>;
    if (columns.some((column) => column.name === "can_invite")) return;
    this.database.exec(
      "ALTER TABLE host_membership ADD COLUMN can_invite INTEGER NOT NULL DEFAULT 0",
    );
    this.database.exec("UPDATE host_membership SET can_invite = 1 WHERE role = 'owner'");
  }

  async state(): Promise<"setup" | "ready"> {
    await this.ready;
    const owner = this.database
      .prepare("SELECT 1 AS found FROM host_membership WHERE role = 'owner' LIMIT 1")
      .get();
    return owner ? "ready" : "setup";
  }

  async setup(input: {
    username: string;
    email: string;
    password: string;
    headers?: Headers;
  }): Promise<Response> {
    const previous = this.setupQueue;
    let release!: () => void;
    this.setupQueue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    await previous;
    let transactionOpen = false;
    try {
      await this.ready;
      try {
        this.database.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
      } catch (error) {
        if (error instanceof Error && /busy|locked/i.test(error.message)) {
          return Response.json(
            { ok: false, error: "Host setup is already in progress", code: "SETUP_IN_PROGRESS" },
            { status: 409 },
          );
        }
        throw error;
      }
      const owner = this.database
        .prepare("SELECT 1 AS found FROM host_membership WHERE role = 'owner' LIMIT 1")
        .get();
      if (owner) {
        this.database.exec("ROLLBACK");
        transactionOpen = false;
        return Response.json(
          { ok: false, error: "Host setup has already been completed", code: "SETUP_COMPLETE" },
          { status: 409 },
        );
      }
      const response = await this.auth.handler(
        jsonRequest(
          `${this.authBaseURL}/api/auth/sign-up/email`,
          {
            name: input.username,
            username: input.username,
            email: input.email,
            password: input.password,
          },
          input.headers,
        ),
      );
      if (!response.ok) {
        this.database.exec("ROLLBACK");
        transactionOpen = false;
        const failure = (await response.json().catch(() => null)) as { code?: unknown } | null;
        const accountExists =
          typeof failure?.code === "string" &&
          ["USERNAME_IS_ALREADY_TAKEN", "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"].includes(
            failure.code,
          );
        return Response.json(
          {
            ok: false,
            error: accountExists
              ? "Username or email is already in use"
              : "Account details are invalid",
            code: accountExists ? "ACCOUNT_EXISTS" : "INVITE_ACCOUNT_INVALID",
            recoverable: true,
          },
          { status: accountExists ? 409 : 400 },
        );
      }
      const body = (await response.json()) as {
        token?: string;
        user?: { id?: string; username?: string; email?: string };
      };
      if (!body.user?.id) throw new Error("Better Auth did not return the created user");
      this.database
        .prepare(
          "INSERT INTO host_membership (user_id, team_id, role, can_invite, created_at) VALUES (?, ?, 'owner', 1, ?)",
        )
        .run(body.user.id, TEAM_ID, Date.now());
      this.database.exec("COMMIT");
      transactionOpen = false;
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return Response.json(
        {
          ok: true,
          value: {
            token: body.token,
            actor: {
              type: "user",
              id: body.user.id,
              displayName: body.user.username || input.username,
              role: "owner",
            },
            user: body.user,
          },
        },
        { status: 201, headers },
      );
    } catch (error) {
      if (transactionOpen) this.database.exec("ROLLBACK");
      throw error;
    } finally {
      release();
    }
  }

  async login(usernameValue: string, password: string, headers: Headers) {
    await this.ready;
    const response = await this.auth.handler(
      jsonRequest(
        `${this.authBaseURL}/api/auth/sign-in/username`,
        { username: usernameValue, password },
        headers,
      ),
    );
    if (!response.ok) {
      this.audit.record(identityAuditEventTypes.loginFailed, null);
      // Keep every credential failure identical so this endpoint cannot be used
      // to distinguish an unknown username from a wrong password.
      return Response.json(
        { ok: false, error: "Invalid username or password", code: "INVALID_CREDENTIALS" },
        { status: 401 },
      );
    }
    const body = (await response.json()) as { token?: string; user?: Record<string, unknown> };
    if (!body.user || typeof body.user.id !== "string") return response;
    const membership = this.membership(body.user.id);
    if (!membership) {
      if (body.token) this.revokeSessionToken(body.token);
      this.audit.record(identityAuditEventTypes.loginFailed, null);
      return Response.json(
        { ok: false, error: "Invalid username or password", code: "INVALID_CREDENTIALS" },
        { status: 401 },
      );
    }
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-length");
    const user = body.user as Record<string, unknown> & {
      id: string;
      username?: string | null;
      name?: string | null;
      email?: string | null;
    };
    return Response.json(
      {
        ok: true,
        value: {
          token: body.token,
          actor: {
            type: "user",
            id: user.id,
            displayName: user.username || user.name || user.email || usernameValue,
            role: membership.role,
          },
          user,
        },
      },
      { headers: responseHeaders },
    );
  }

  async logout(headers: Headers) {
    await this.ready;
    const response = await this.auth.handler(
      new Request(`${this.authBaseURL}/api/auth/sign-out`, { method: "POST", headers }),
    );
    if (!response.ok) return response;
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-length");
    return Response.json({ ok: true, value: true }, { headers: responseHeaders });
  }

  async resolveActor(request: Request): Promise<Actor | null> {
    await this.ready;
    const token = request.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "")
      .trim();
    if (token?.startsWith(API_KEY_PREFIX)) return this.resolveApiKey(token);
    const session = await this.auth.api.getSession({ headers: request.headers });
    if (!session?.user?.id) return null;
    const membership = this.membership(session.user.id);
    if (!membership) return null;
    const user = session.user as typeof session.user & { username?: string | null };
    return {
      type: "user",
      id: user.id,
      displayName: user.username || user.name || user.email,
      role: membership.role,
    };
  }

  async me(request: Request) {
    const actor = await this.resolveActor(request);
    if (!actor) return null;
    const session =
      actor.type === "user" ? await this.auth.api.getSession({ headers: request.headers }) : null;
    return {
      actor,
      user: session?.user ?? null,
      pathPolicy: await this.pathPolicyStatus(actor),
    };
  }

  async pathPolicyStatus(actor?: Actor | null) {
    await this.ready;
    const revision = this.pathPolicyRevision();
    const restricted = actor ? this.isRestrictedActor(actor) : false;
    return {
      mode: this.pathGrantsMode,
      revision,
      restricted,
      foundationReady: true,
      enforcementReady: true,
    };
  }

  /**
   * Rehydrates durable attribution into the actor that exists now. Durable
   * labels and historical roles are deliberately not authorization inputs.
   */
  async resolveDurableActor(actor: DurableActor): Promise<Actor | null> {
    await this.ready;
    if (actor.type === "user") {
      const row = this.database
        .prepare(
          `SELECT m.user_id AS id, m.role, u.username, u.name, u.email
           FROM host_membership m JOIN user u ON u.id = m.user_id
           WHERE m.user_id = ?`,
        )
        .get(actor.id) as
        | {
            id: string;
            role: HostRole;
            username: string | null;
            name: string | null;
            email: string;
          }
        | undefined;
      return row
        ? {
            type: "user",
            id: row.id,
            displayName: row.username || row.name || row.email,
            role: row.role,
          }
        : null;
    }
    if (actor.type === "api_key") {
      const row = this.database
        .prepare(
          `SELECT id, label, role FROM host_api_key
           WHERE id = ? AND revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .get(actor.id, Date.now()) as ApiKeyRow | undefined;
      return row ? { type: "api_key", id: row.id, displayName: row.label, role: row.role } : null;
    }
    return actor.type === "local"
      ? { type: "local", id: actor.id, displayName: "", role: "owner" }
      : null;
  }

  async effectivePathPolicy(actor: Actor): Promise<EffectivePathPolicy> {
    await this.ready;
    const restricted = this.isRestrictedActor(actor);
    const grants = restricted
      ? (this.database
          .prepare(
            `SELECT root_path AS root, access FROM host_path_grant
             WHERE subject_type = ? AND subject_id = ? ORDER BY root_path`,
          )
          .all(actor.type, actor.id) as { root: string; access: PathGrantAccess }[])
      : [];
    return createEffectivePathPolicy({
      revision: this.pathPolicyRevision(),
      restricted,
      allowedRoots: await this.getAllowedRoots(),
      grants,
    });
  }

  async canActorAccessProject(actor: Actor, canonicalProjectPath: string) {
    return await (await this.effectivePathPolicy(actor)).canAccessProject(canonicalProjectPath);
  }

  async listPathGrants(actor: Actor, subjectType: "user" | "api_key", subjectId: string) {
    await this.ready;
    this.requireOwnerUser(actor);
    this.requireGrantSubject(subjectType, subjectId);
    return {
      subject: { type: subjectType, id: subjectId },
      revision: this.pathPolicyRevision(),
      grants: this.database
        .prepare(
          `SELECT root_path AS root, access FROM host_path_grant
           WHERE subject_type = ? AND subject_id = ? ORDER BY root_path`,
        )
        .all(subjectType, subjectId),
    };
  }

  async replacePathGrants(
    actor: Actor,
    subjectType: "user" | "api_key",
    subjectId: string,
    grants: { root: string; access: PathGrantAccess }[],
  ) {
    await this.ready;
    this.requireOwnerUser(actor);
    this.requireGrantSubject(subjectType, subjectId);
    const roots = await this.getAllowedRoots();
    let canonical: { root: string; access: PathGrantAccess }[];
    try {
      canonical = await Promise.all(
        grants.map(async (grant) => ({
          root: await canonicalizeGrantRoot(grant.root, roots),
          access: grant.access,
        })),
      );
    } catch (error) {
      throw new IdentityError(
        "INVALID_GRANT_ROOT",
        400,
        error instanceof Error ? error.message : "Grant root is invalid",
      );
    }
    const merged = new Map<string, PathGrantAccess>();
    for (const grant of canonical) {
      const previous = merged.get(grant.root);
      merged.set(grant.root, previous === "write" ? "write" : grant.access);
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      // Recheck after asynchronous canonicalization so removal cannot race a stale subject check.
      this.requireGrantSubject(subjectType, subjectId);
      this.database
        .prepare("DELETE FROM host_path_grant WHERE subject_type = ? AND subject_id = ?")
        .run(subjectType, subjectId);
      const insert = this.database.prepare(
        `INSERT INTO host_path_grant
          (subject_type, subject_id, root_path, access, created_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const now = Date.now();
      for (const [root, access] of merged) {
        insert.run(subjectType, subjectId, root, access, actor.id, now);
      }
      const revision = this.incrementPathPolicyRevision();
      this.database.exec("COMMIT");
      return {
        subject: { type: subjectType, id: subjectId },
        revision,
        grants: [...merged].map(([root, access]) => ({ root, access })),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async mintApiKey(
    actor: Actor,
    input: { label: string; role: HostRole; expiresAt?: number | null },
  ) {
    await this.ready;
    this.requireOwnerUser(actor);
    if (
      input.expiresAt !== undefined &&
      input.expiresAt !== null &&
      input.expiresAt <= Date.now()
    ) {
      throw new IdentityError("INVALID_EXPIRY", 400, "API key expiry must be in the future");
    }
    const id = randomUUID();
    const secret = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
    this.database
      .prepare(
        `INSERT INTO host_api_key
          (id, label, secret_hash, role, created_by_user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.label,
        hashSecret(secret),
        input.role,
        actor.id,
        Date.now(),
        input.expiresAt ?? null,
      );
    this.audit.record(identityAuditEventTypes.apiKeyMinted, actor, {
      type: "api_key",
      id,
      displayName: input.label,
    });
    return { id, label: input.label, role: input.role, secret, expiresAt: input.expiresAt ?? null };
  }

  async listApiKeys(actor: Actor) {
    await this.ready;
    this.requireOwnerUser(actor);
    return this.database
      .prepare(
        `SELECT id, label, role, created_at AS createdAt, expires_at AS expiresAt,
                revoked_at AS revokedAt
         FROM host_api_key ORDER BY created_at DESC`,
      )
      .all();
  }

  async revokeApiKey(actor: Actor, id: string) {
    await this.ready;
    this.requireOwnerUser(actor);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database
        .prepare("UPDATE host_api_key SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(Date.now(), id);
      if (result.changes === 0) {
        throw new IdentityError("API_KEY_NOT_FOUND", 404, "API key not found");
      }
      const removed = this.deleteSubjectGrants("api_key", id);
      if (removed) this.incrementPathPolicyRevision();
      this.audit.record(identityAuditEventTypes.apiKeyRevoked, actor, {
        type: "api_key",
        id,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async createInvite(
    actor: Actor,
    input: {
      email: string;
      expiresAt?: number;
      pathGrants?: { root: string; access: PathGrantAccess }[];
    },
  ) {
    await this.ready;
    this.requireCanInvite(actor);
    const now = Date.now();
    const expiresAt = input.expiresAt ?? now + 7 * 24 * 60 * 60 * 1000;
    if (expiresAt <= now) {
      throw new IdentityError("INVALID_EXPIRY", 400, "Invite expiry must be in the future");
    }
    const pathGrants = await this.canonicalizeDelegatedPathGrants(actor, input.pathGrants ?? []);
    const active = this.database
      .prepare(
        `SELECT 1 FROM host_invite
         WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? LIMIT 1`,
      )
      .get(input.email, now);
    if (active) {
      throw new IdentityError("INVITE_EXISTS", 409, "An active invite already exists");
    }
    const existingMember = this.database
      .prepare(
        `SELECT 1 FROM host_membership m JOIN user u ON u.id = m.user_id
         WHERE lower(u.email) = lower(?) LIMIT 1`,
      )
      .get(input.email);
    if (existingMember) {
      throw new IdentityError("ALREADY_MEMBER", 409, "This email is already a member");
    }
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT INTO host_invite
            (id, email, token_hash, created_by_user_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.email, hashSecret(token), actor.id, now, expiresAt);
      const insertGrant = this.database.prepare(
        `INSERT INTO host_invite_path_grant (invite_id, root_path, access) VALUES (?, ?, ?)`,
      );
      for (const grant of pathGrants) {
        insertGrant.run(id, grant.root, grant.access);
      }
      this.audit.record(identityAuditEventTypes.inviteCreated, actor, { type: "invite", id });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return {
      id,
      email: input.email,
      role: "member" as const,
      token,
      createdAt: now,
      expiresAt,
      pathGrants,
    };
  }

  async listInvites(actor: Actor) {
    await this.ready;
    this.requireCanInvite(actor);
    const rows = this.database
      .prepare(
        actor.role === "owner"
          ? `SELECT id, email, 'member' AS role, created_by_user_id AS createdByUserId,
                    created_at AS createdAt, expires_at AS expiresAt
             FROM host_invite
             WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
             ORDER BY created_at DESC`
          : `SELECT id, email, 'member' AS role, created_by_user_id AS createdByUserId,
                    created_at AS createdAt, expires_at AS expiresAt
             FROM host_invite
             WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
               AND created_by_user_id = ?
             ORDER BY created_at DESC`,
      )
      .all(...(actor.role === "owner" ? [Date.now()] : [Date.now(), actor.id])) as Array<{
      id: string;
      email: string;
      role: "member";
      createdByUserId: string;
      createdAt: number;
      expiresAt: number;
    }>;
    return rows.map((row) => ({
      ...row,
      pathGrants: this.database
        .prepare(
          `SELECT root_path AS root, access FROM host_invite_path_grant WHERE invite_id = ? ORDER BY root_path`,
        )
        .all(row.id),
    }));
  }

  async revokeInvite(actor: Actor, id: string) {
    await this.ready;
    this.requireCanInvite(actor);
    const now = Date.now();
    const invite = this.database
      .prepare(
        `SELECT id, created_by_user_id AS createdByUserId FROM host_invite
         WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(id, now) as { id: string; createdByUserId: string } | undefined;
    if (!invite) {
      throw new IdentityError("INVITE_NOT_FOUND", 404, "Active invite not found");
    }
    if (actor.role !== "owner" && invite.createdByUserId !== actor.id) {
      throw new IdentityError("FORBIDDEN", 403, "You can only revoke invites you created");
    }
    this.database.prepare(`UPDATE host_invite SET revoked_at = ? WHERE id = ?`).run(now, id);
    this.database.prepare("DELETE FROM host_invite_path_grant WHERE invite_id = ?").run(id);
    this.audit.record(identityAuditEventTypes.inviteRevoked, actor, { type: "invite", id });
  }

  async acceptInvite(input: {
    token: string;
    username: string;
    email: string;
    password: string;
    headers?: Headers;
  }): Promise<Response> {
    const previous = this.inviteAcceptQueue;
    let release!: () => void;
    this.inviteAcceptQueue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    await previous;
    let transactionOpen = false;
    try {
      await this.ready;
      this.database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const invite = this.database
        .prepare(
          `SELECT id, email, created_by_user_id, created_at, expires_at, accepted_at, revoked_at
           FROM host_invite WHERE token_hash = ?`,
        )
        .get(hashSecret(input.token)) as InviteRow | undefined;
      const now = Date.now();
      if (!invite || invite.accepted_at || invite.revoked_at || invite.expires_at <= now) {
        this.database.exec("ROLLBACK");
        transactionOpen = false;
        return Response.json(
          { ok: false, error: "Invite is invalid or expired", code: "INVITE_INVALID" },
          { status: 410 },
        );
      }
      if (invite.email.toLowerCase() !== input.email.toLowerCase()) {
        this.database.exec("ROLLBACK");
        transactionOpen = false;
        return Response.json(
          { ok: false, error: "Email does not match the invite", code: "INVITE_EMAIL_MISMATCH" },
          { status: 400 },
        );
      }
      const response = await this.auth.handler(
        jsonRequest(
          `${this.authBaseURL}/api/auth/sign-up/email`,
          {
            name: input.username,
            username: input.username,
            email: input.email,
            password: input.password,
          },
          input.headers,
        ),
      );
      if (!response.ok) {
        this.database.exec("ROLLBACK");
        transactionOpen = false;
        return response;
      }
      const body = (await response.json()) as {
        token?: string;
        user?: { id?: string; username?: string; email?: string };
      };
      if (!body.user?.id) throw new Error("Better Auth did not return the invited user");
      this.database
        .prepare(
          "INSERT INTO host_membership (user_id, team_id, role, can_invite, created_at) VALUES (?, ?, 'member', 0, ?)",
        )
        .run(body.user.id, TEAM_ID, now);
      const accepted = this.database
        .prepare(
          `UPDATE host_invite SET accepted_at = ?, accepted_by_user_id = ?
           WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
        )
        .run(now, body.user.id, invite.id);
      if (accepted.changes !== 1) throw new Error("Invite was consumed concurrently");
      const inviteGrants = this.database
        .prepare(`SELECT root_path AS root, access FROM host_invite_path_grant WHERE invite_id = ?`)
        .all(invite.id) as { root: string; access: PathGrantAccess }[];
      if (inviteGrants.length > 0) {
        const insertGrant = this.database.prepare(
          `INSERT INTO host_path_grant
            (subject_type, subject_id, root_path, access, created_by_user_id, created_at)
           VALUES ('user', ?, ?, ?, ?, ?)`,
        );
        for (const grant of inviteGrants) {
          insertGrant.run(body.user.id, grant.root, grant.access, invite.created_by_user_id, now);
        }
        this.incrementPathPolicyRevision();
      }
      this.database
        .prepare("DELETE FROM host_invite_path_grant WHERE invite_id = ?")
        .run(invite.id);
      this.audit.record(
        identityAuditEventTypes.inviteAccepted,
        {
          type: "user",
          id: body.user.id,
          displayName: body.user.username || input.username,
          role: "member",
        },
        { type: "invite", id: invite.id },
      );
      this.database.exec("COMMIT");
      transactionOpen = false;
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return Response.json(
        {
          ok: true,
          value: {
            token: body.token,
            actor: {
              type: "user",
              id: body.user.id,
              displayName: body.user.username || input.username,
              role: "member",
            },
            user: body.user,
          },
        },
        { status: 201, headers },
      );
    } catch (error) {
      if (transactionOpen) this.database.exec("ROLLBACK");
      throw error;
    } finally {
      release();
    }
  }

  async listMembers(actor: Actor) {
    await this.ready;
    this.requireOwnerUser(actor);
    return (
      this.database
        .prepare(
          `SELECT u.id, u.username, u.name, u.email, m.role, m.can_invite AS canInvite,
                  m.created_at AS createdAt
           FROM host_membership m JOIN user u ON u.id = m.user_id
           ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.created_at ASC`,
        )
        .all() as Array<{
        id: string;
        username: string | null;
        name: string | null;
        email: string;
        role: HostRole;
        canInvite: number;
        createdAt: number;
      }>
    ).map((row) => ({
      id: row.id,
      username: row.username,
      name: row.name,
      email: row.email,
      role: row.role,
      canInvite: row.role === "owner" ? true : row.canInvite === 1,
      createdAt: row.createdAt,
    }));
  }

  async listSharePrincipals(actor: Actor) {
    await this.ready;
    if (actor.type !== "user") throw new IdentityError("FORBIDDEN", 403, "User access required");
    const users = this.database
      .prepare(
        `SELECT u.id, COALESCE(u.username, u.name, u.email) AS name
       FROM host_membership m JOIN user u ON u.id = m.user_id
       ORDER BY name`,
      )
      .all();
    return { users, teams: [{ id: TEAM_ID, name: "Team" }] };
  }

  async setMemberCanInvite(actor: Actor, userId: string, canInvite: boolean) {
    await this.ready;
    this.requireOwnerUser(actor);
    const membership = this.membership(userId);
    if (!membership) throw new IdentityError("MEMBER_NOT_FOUND", 404, "Member not found");
    if (membership.role === "owner") {
      throw new IdentityError("OWNER_CAPABILITY_LOCKED", 409, "The Host owner always can invite");
    }
    this.database
      .prepare("UPDATE host_membership SET can_invite = ? WHERE user_id = ?")
      .run(canInvite ? 1 : 0, userId);
    return { id: userId, canInvite };
  }

  async publicPolicy() {
    await this.ready;
    return {
      registrationMode: this.registrationMode(),
      identity: await this.state(),
    };
  }

  async getHostPolicy(actor: Actor) {
    await this.ready;
    this.requireOwnerUser(actor);
    return {
      registrationMode: this.registrationMode(),
      pathGrantsMode: this.pathGrantsMode,
    };
  }

  async setRegistrationMode(actor: Actor, mode: RegistrationMode) {
    await this.ready;
    this.requireOwnerUser(actor);
    if (mode !== "invite_only" && mode !== "open") {
      throw new IdentityError("INVALID_REGISTRATION_MODE", 400, "registrationMode is invalid");
    }
    this.database
      .prepare(
        `INSERT INTO host_identity_config (key, value) VALUES ('registration_mode', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(mode);
    return { registrationMode: mode };
  }

  async register(input: {
    username: string;
    email: string;
    password: string;
    headers?: Headers;
  }): Promise<Response> {
    await this.ready;
    if ((await this.state()) !== "ready") {
      return Response.json(
        { ok: false, error: "Host setup is not complete", code: "SETUP_REQUIRED" },
        { status: 409 },
      );
    }
    if (this.registrationMode() !== "open") {
      return Response.json(
        {
          ok: false,
          error: "Open registration is disabled on this Host",
          code: "REGISTRATION_CLOSED",
        },
        { status: 403 },
      );
    }
    const response = await this.auth.handler(
      jsonRequest(
        `${this.authBaseURL}/api/auth/sign-up/email`,
        {
          name: input.username,
          username: input.username,
          email: input.email,
          password: input.password,
        },
        input.headers,
      ),
    );
    if (!response.ok) {
      const failure = (await response.json().catch(() => null)) as { code?: unknown } | null;
      const accountExists =
        typeof failure?.code === "string" &&
        ["USERNAME_IS_ALREADY_TAKEN", "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"].includes(
          failure.code,
        );
      return Response.json(
        {
          ok: false,
          error: accountExists
            ? "Username or email is already in use"
            : "Account details are invalid",
          code: accountExists ? "ACCOUNT_EXISTS" : "REGISTER_INVALID",
          recoverable: true,
        },
        { status: accountExists ? 409 : 400 },
      );
    }
    const body = (await response.json()) as {
      token?: string;
      user?: { id?: string; username?: string; email?: string };
    };
    if (!body.user?.id) throw new Error("Better Auth did not return the registered user");
    this.database
      .prepare(
        "INSERT INTO host_membership (user_id, team_id, role, can_invite, created_at) VALUES (?, ?, 'member', 0, ?)",
      )
      .run(body.user.id, TEAM_ID, Date.now());
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return Response.json(
      {
        ok: true,
        value: {
          token: body.token,
          actor: {
            type: "user",
            id: body.user.id,
            displayName: body.user.username || input.username,
            role: "member",
          },
          user: body.user,
        },
      },
      { status: 201, headers },
    );
  }

  async recordSessionOwner(sessionId: string, actor: Actor) {
    await this.ready;
    if (actor.type === "local") return;
    const ownerType = actor.type === "api_key" ? "api_key" : "user";
    this.database
      .prepare(
        `INSERT OR IGNORE INTO host_session_access
          (session_id, owner_type, owner_id, pinned_connection_id, created_at)
         VALUES (?, ?, ?, NULL, ?)`,
      )
      .run(sessionId, ownerType, actor.id, Date.now());
  }

  async deleteSessionAccess(sessionId: string) {
    await this.ready;
    this.database.prepare("DELETE FROM host_session_share WHERE session_id = ?").run(sessionId);
    this.database.prepare("DELETE FROM host_session_view_link WHERE session_id = ?").run(sessionId);
    this.database.prepare("DELETE FROM host_session_access WHERE session_id = ?").run(sessionId);
  }

  async authorizeSessionAction(
    sessionId: string,
    actor: Actor,
    action: SessionAccessAction,
  ): Promise<void> {
    await this.ready;
    if (actor.type === "local") return;
    const access = this.database
      .prepare(
        `SELECT owner_type AS ownerType, owner_id AS ownerId, pinned_connection_id AS pinnedConnectionId
         FROM host_session_access WHERE session_id = ?`,
      )
      .get(sessionId) as
      | { ownerType: "user" | "api_key"; ownerId: string; pinnedConnectionId: string | null }
      | undefined;
    // Legacy Sessions created before ACL rows remain visible to path-authorized actors.
    if (!access) return;
    const role = this.sessionRoleForActor(sessionId, access, actor);
    if (!role || sessionRoleRank(role) < sessionActionRank(action)) {
      throw new IdentityError("SESSION_FORBIDDEN", 404, "Session not found");
    }
    if (action === "run" && role !== "owner") {
      const teamShare =
        actor.type === "user" &&
        (this.database
          .prepare(
            `SELECT role FROM host_session_share
         WHERE session_id = ? AND grantee_type = 'team' AND grantee_id = ?`,
          )
          .get(sessionId, TEAM_ID) as { role: "view" | "run" | "admin" } | undefined);
      if (
        !teamShare ||
        sessionRoleRank(teamShare.role) < sessionRoleRank("run") ||
        !access.pinnedConnectionId ||
        !this.canUseModelConnection(actor, access.pinnedConnectionId)
      ) {
        throw new IdentityError("SESSION_FORBIDDEN", 404, "Session not found");
      }
    }
  }

  async sessionAccessSummary(sessionId: string, actor: Actor) {
    await this.ready;
    if (actor.type === "local") return { accessRole: "owner" as const, shared: false };
    const access = this.database
      .prepare(
        `SELECT owner_type AS ownerType, owner_id AS ownerId FROM host_session_access WHERE session_id = ?`,
      )
      .get(sessionId) as { ownerType: "user" | "api_key"; ownerId: string } | undefined;
    if (!access) return { accessRole: "owner" as const, shared: false };
    const role = this.sessionRoleForActor(sessionId, access, actor);
    const shared = Boolean(
      this.database
        .prepare("SELECT 1 FROM host_session_share WHERE session_id = ? LIMIT 1")
        .get(sessionId),
    );
    return { accessRole: role, shared };
  }

  async filterVisibleSessionIds(sessionIds: string[], actor: Actor): Promise<string[]> {
    await this.ready;
    if (actor.type === "local" || sessionIds.length === 0) return sessionIds;
    const visible: string[] = [];
    for (const sessionId of sessionIds) {
      try {
        await this.authorizeSessionAction(sessionId, actor, "view");
        visible.push(sessionId);
      } catch {
        // skip
      }
    }
    return visible;
  }

  async shareSession(
    actor: Actor,
    sessionId: string,
    input: { granteeType: "user" | "team"; granteeId: string; role: "view" | "run" | "admin" },
  ) {
    await this.ready;
    await this.authorizeSessionAction(sessionId, actor, "admin");
    if (input.granteeType === "team" && input.granteeId !== TEAM_ID) {
      throw new IdentityError("INVALID_GRANTEE", 400, "Unknown Team");
    }
    if (input.granteeType === "user") {
      this.requireGrantSubject("user", input.granteeId);
    }
    // run shares are Team-only under ADR 0013 collab rules.
    if (input.role === "run" && input.granteeType !== "team") {
      throw new IdentityError(
        "INVALID_SESSION_SHARE",
        400,
        "run access can only be shared with a Team",
      );
    }
    this.database
      .prepare(
        `INSERT INTO host_session_share
          (session_id, grantee_type, grantee_id, role, created_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, grantee_type, grantee_id)
         DO UPDATE SET role = excluded.role`,
      )
      .run(sessionId, input.granteeType, input.granteeId, input.role, actor.id, Date.now());
    return {
      sessionId,
      granteeType: input.granteeType,
      granteeId: input.granteeId,
      role: input.role,
    };
  }

  async listSessionShares(actor: Actor, sessionId: string) {
    await this.ready;
    await this.authorizeSessionAction(sessionId, actor, "admin");
    return this.database
      .prepare(
        `SELECT grantee_type AS granteeType, grantee_id AS granteeId, role,
                created_by_user_id AS createdByUserId, created_at AS createdAt
         FROM host_session_share WHERE session_id = ? ORDER BY created_at ASC`,
      )
      .all(sessionId);
  }

  async revokeSessionShare(
    actor: Actor,
    sessionId: string,
    granteeType: "user" | "team",
    granteeId: string,
  ) {
    await this.ready;
    await this.authorizeSessionAction(sessionId, actor, "admin");
    const result = this.database
      .prepare(
        `DELETE FROM host_session_share
         WHERE session_id = ? AND grantee_type = ? AND grantee_id = ?`,
      )
      .run(sessionId, granteeType, granteeId);
    if (result.changes === 0) {
      throw new IdentityError("SHARE_NOT_FOUND", 404, "Session share not found");
    }
    return { revoked: true };
  }

  async createSessionViewLink(
    actor: Actor,
    sessionId: string,
    input: { expiresAt?: number | null } = {},
  ) {
    await this.ready;
    await this.authorizeSessionAction(sessionId, actor, "admin");
    const now = Date.now();
    const expiresAt = input.expiresAt ?? now + 7 * 24 * 60 * 60 * 1000;
    if (expiresAt !== null && expiresAt <= now) {
      throw new IdentityError("INVALID_EXPIRY", 400, "View link expiry must be in the future");
    }
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    this.database
      .prepare(
        `INSERT INTO host_session_view_link
          (id, session_id, token_hash, created_by_user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sessionId, hashSecret(token), actor.id, now, expiresAt);
    return { id, sessionId, token, createdAt: now, expiresAt };
  }

  async resolveSessionViewLink(token: string) {
    await this.ready;
    const row = this.database
      .prepare(
        `SELECT id, session_id AS sessionId, expires_at AS expiresAt, revoked_at AS revokedAt
         FROM host_session_view_link WHERE token_hash = ?`,
      )
      .get(hashSecret(token)) as
      | { id: string; sessionId: string; expiresAt: number | null; revokedAt: number | null }
      | undefined;
    if (!row || row.revokedAt || (row.expiresAt !== null && row.expiresAt <= Date.now())) {
      throw new IdentityError("VIEW_LINK_INVALID", 410, "View link is invalid or expired");
    }
    return { id: row.id, sessionId: row.sessionId };
  }

  async listSessionViewLinks(actor: Actor, sessionId: string) {
    await this.ready;
    await this.authorizeSessionAction(sessionId, actor, "admin");
    return this.database
      .prepare(
        `SELECT id, session_id AS sessionId, created_at AS createdAt, expires_at AS expiresAt
       FROM host_session_view_link
       WHERE session_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC`,
      )
      .all(sessionId, Date.now());
  }

  async revokeSessionViewLink(actor: Actor, linkId: string) {
    await this.ready;
    const row = this.database
      .prepare(`SELECT session_id AS sessionId FROM host_session_view_link WHERE id = ?`)
      .get(linkId) as { sessionId: string } | undefined;
    if (!row) throw new IdentityError("VIEW_LINK_NOT_FOUND", 404, "View link not found");
    await this.authorizeSessionAction(row.sessionId, actor, "admin");
    this.database
      .prepare(
        `UPDATE host_session_view_link SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(Date.now(), linkId);
    return { revoked: true };
  }

  private sessionRoleForActor(
    sessionId: string,
    access: { ownerType: "user" | "api_key"; ownerId: string },
    actor: Actor,
  ): SessionAccessRole | null {
    if (actor.type === access.ownerType && actor.id === access.ownerId) return "owner";
    if (actor.type === "user") {
      const userShare = this.database
        .prepare(
          `SELECT role FROM host_session_share
           WHERE session_id = ? AND grantee_type = 'user' AND grantee_id = ?`,
        )
        .get(sessionId, actor.id) as { role: "view" | "run" | "admin" } | undefined;
      if (userShare) return userShare.role;
      const teamShare = this.database
        .prepare(
          `SELECT role FROM host_session_share
           WHERE session_id = ? AND grantee_type = 'team' AND grantee_id = ?`,
        )
        .get(sessionId, TEAM_ID) as { role: "view" | "run" | "admin" } | undefined;
      if (teamShare) return teamShare.role;
    }
    return null;
  }

  private async canonicalizeDelegatedPathGrants(
    actor: Actor,
    grants: { root: string; access: PathGrantAccess }[],
  ) {
    if (grants.length === 0) return [] as { root: string; access: PathGrantAccess }[];
    const roots = await this.getAllowedRoots();
    let canonical: { root: string; access: PathGrantAccess }[];
    try {
      canonical = await Promise.all(
        grants.map(async (grant) => ({
          root: await canonicalizeGrantRoot(grant.root, roots),
          access: grant.access,
        })),
      );
    } catch (error) {
      throw new IdentityError(
        "INVALID_GRANT_ROOT",
        400,
        error instanceof Error ? error.message : "Grant root is invalid",
      );
    }
    if (actor.role === "owner" && actor.type === "user") {
      return mergePathGrants(canonical);
    }
    const policy = await this.effectivePathPolicy(actor);
    if (!policy.restricted) {
      // Unrestricted non-owner (path grants disabled): still cannot escalate beyond Host roots,
      // which canonicalizeGrantRoot already enforced.
      return mergePathGrants(canonical);
    }
    const allowed = policy.grants;
    for (const grant of canonical) {
      const inviterAccess = coveringGrantAccess(grant.root, allowed);
      if (!inviterAccess) {
        throw new IdentityError(
          "GRANT_NOT_DELEGATABLE",
          403,
          "You can only share paths you can access",
        );
      }
      if (grant.access === "write" && inviterAccess !== "write") {
        throw new IdentityError(
          "GRANT_NOT_DELEGATABLE",
          403,
          "You cannot grant write access beyond your own access",
        );
      }
    }
    return mergePathGrants(canonical);
  }

  private registrationMode(): RegistrationMode {
    const row = this.database
      .prepare("SELECT value FROM host_identity_config WHERE key = 'registration_mode'")
      .get() as { value: string } | undefined;
    return row?.value === "open" ? "open" : "invite_only";
  }

  private requireCanInvite(actor: Actor) {
    if (actor.type !== "user") {
      throw new IdentityError("FORBIDDEN", 403, "Only users may create invites");
    }
    if (actor.role === "owner") return;
    const membership = this.membership(actor.id);
    if (!membership || membership.can_invite !== 1) {
      throw new IdentityError("FORBIDDEN", 403, "Invite permission required");
    }
  }

  async registerLegacyHostConnections(connectionIds: string[]) {
    await this.ready;
    const owner = this.database
      .prepare("SELECT user_id AS id FROM host_membership WHERE role = 'owner' LIMIT 1")
      .get() as { id: string } | undefined;
    if (!owner) return;
    const insert = this.database.prepare(
      `INSERT OR IGNORE INTO host_model_connection
       (id, plane, owner_type, owner_id, credential_kind, created_by_user_id, created_at, updated_at)
       VALUES (?, 'host', 'host', ?, 'byok', ?, ?, ?)`,
    );
    const now = Date.now();
    for (const id of connectionIds) insert.run(id, TEAM_ID, owner.id, now, now);
  }

  async listModelConnectionAccess(actor: Actor): Promise<ModelConnectionAccess[]> {
    await this.ready;
    if (actor.type === "local") return [];
    const rows = this.database
      .prepare(
        `SELECT id, plane, owner_type AS ownerType, owner_id AS ownerId,
                credential_kind AS credentialKind
         FROM host_model_connection ORDER BY created_at ASC`,
      )
      .all() as ModelConnectionAccess[];
    return rows.filter((row) => this.canUseModelConnection(actor, row.id));
  }

  async recordModelConnection(
    actor: Actor,
    input: { id: string; plane: ModelConnectionPlane; credentialKind: ModelCredentialKind },
  ) {
    await this.ready;
    if (actor.type !== "user") throw new IdentityError("FORBIDDEN", 403, "User access required");
    const ownerType = input.plane === "host" ? "host" : input.plane;
    const ownerId = input.plane === "host" || input.plane === "team" ? TEAM_ID : actor.id;
    if (input.plane !== "user") this.requireOwnerUser(actor);
    if (input.plane !== "host" && !this.modelCredentialAllowed(input.credentialKind)) {
      throw new IdentityError(
        "MODEL_CREDENTIAL_POLICY_DENIED",
        403,
        "This credential type is disabled by Host policy",
      );
    }
    const existing = this.modelConnection(input.id);
    if (existing && !this.canManageModelConnection(actor, existing)) {
      throw new IdentityError("FORBIDDEN", 403, "Model connection access denied");
    }
    const now = Date.now();
    this.database
      .prepare(
        `INSERT INTO host_model_connection
       (id, plane, owner_type, owner_id, credential_kind, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET plane = excluded.plane, owner_type = excluded.owner_type,
         owner_id = excluded.owner_id, credential_kind = excluded.credential_kind,
         updated_at = excluded.updated_at`,
      )
      .run(input.id, input.plane, ownerType, ownerId, input.credentialKind, actor.id, now, now);
    return this.modelConnection(input.id)!;
  }

  async removeModelConnection(actor: Actor, connectionId: string) {
    await this.ready;
    const connection = this.modelConnection(connectionId);
    if (!connection)
      throw new IdentityError("MODEL_CONNECTION_NOT_FOUND", 404, "Model connection not found");
    if (!this.canManageModelConnection(actor, connection)) {
      throw new IdentityError("FORBIDDEN", 403, "Model connection access denied");
    }
    this.database.prepare("DELETE FROM host_model_connection WHERE id = ?").run(connectionId);
  }

  async listModelEntitlements(actor: Actor, connectionId: string) {
    await this.ready;
    const connection = this.modelConnection(connectionId);
    if (!connection || !this.canManageModelConnection(actor, connection)) {
      throw new IdentityError("FORBIDDEN", 403, "Model connection access denied");
    }
    return this.database
      .prepare(
        `SELECT subject_type AS subjectType, subject_id AS subjectId, model_id AS modelId
       FROM host_model_entitlement WHERE connection_id = ? ORDER BY subject_type, subject_id, model_id`,
      )
      .all(connectionId);
  }

  async replaceModelEntitlements(
    actor: Actor,
    connectionId: string,
    entitlements: Array<{ subjectType: "user" | "team"; subjectId: string; modelId?: string }>,
  ) {
    await this.ready;
    const connection = this.modelConnection(connectionId);
    if (
      !connection ||
      connection.plane === "user" ||
      !this.canManageModelConnection(actor, connection)
    ) {
      throw new IdentityError("FORBIDDEN", 403, "Model connection access denied");
    }
    for (const item of entitlements) {
      if (item.subjectType === "team" && item.subjectId !== TEAM_ID) {
        throw new IdentityError("INVALID_GRANTEE", 400, "Unknown Team");
      }
      if (item.subjectType === "user") this.requireGrantSubject("user", item.subjectId);
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare("DELETE FROM host_model_entitlement WHERE connection_id = ?")
        .run(connectionId);
      const insert = this.database.prepare(
        `INSERT INTO host_model_entitlement
         (connection_id, subject_type, subject_id, model_id, created_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const item of entitlements) {
        insert.run(
          connectionId,
          item.subjectType,
          item.subjectId,
          item.modelId?.trim() || "*",
          actor.id,
          Date.now(),
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.listModelEntitlements(actor, connectionId);
  }

  async getModelPolicy(actor: Actor) {
    await this.ready;
    this.requireOwnerUser(actor);
    const team = this.database
      .prepare(
        "SELECT allow_byok AS allowByok, allow_byos AS allowByos FROM host_team_model_policy WHERE team_id = ?",
      )
      .get(TEAM_ID) as { allowByok: number; allowByos: number };
    return {
      host: { allowByok: this.configFlag("allow_byok"), allowByos: this.configFlag("allow_byos") },
      team: { allowByok: team.allowByok === 1, allowByos: team.allowByos === 1 },
    };
  }

  async setModelPolicy(
    actor: Actor,
    input: {
      host: { allowByok: boolean; allowByos: boolean };
      team: { allowByok: boolean; allowByos: boolean };
    },
  ) {
    await this.ready;
    this.requireOwnerUser(actor);
    const set = this.database.prepare(
      `INSERT INTO host_identity_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    set.run("allow_byok", input.host.allowByok ? "1" : "0");
    set.run("allow_byos", input.host.allowByos ? "1" : "0");
    this.database
      .prepare(
        `UPDATE host_team_model_policy SET allow_byok = ?, allow_byos = ?, updated_at = ?
       WHERE team_id = ?`,
      )
      .run(input.team.allowByok ? 1 : 0, input.team.allowByos ? 1 : 0, Date.now(), TEAM_ID);
    return this.getModelPolicy(actor);
  }

  async authorizeModelSelection(actor: Actor, connectionId: string, modelId: string) {
    await this.ready;
    if (actor.type === "local") return;
    if (!this.canUseModelConnection(actor, connectionId, modelId)) {
      throw new IdentityError(
        "MODEL_NOT_ENTITLED",
        403,
        "Model connection is not available to this account",
      );
    }
  }

  async pinSessionConnection(sessionId: string, actor: Actor, connectionId: string) {
    await this.authorizeSessionAction(sessionId, actor, "run");
    const connection = this.modelConnection(connectionId);
    if (!connection)
      throw new IdentityError("MODEL_CONNECTION_NOT_FOUND", 404, "Model connection not found");
    this.database
      .prepare("UPDATE host_session_access SET pinned_connection_id = ? WHERE session_id = ?")
      .run(connection.plane === "user" ? null : connectionId, sessionId);
    return { sessionId, pinnedConnectionId: connection.plane === "user" ? null : connectionId };
  }

  private modelConnection(id: string): ModelConnectionAccess | undefined {
    return this.database
      .prepare(
        `SELECT id, plane, owner_type AS ownerType, owner_id AS ownerId,
              credential_kind AS credentialKind FROM host_model_connection WHERE id = ?`,
      )
      .get(id) as ModelConnectionAccess | undefined;
  }

  private canManageModelConnection(actor: Actor, connection: ModelConnectionAccess) {
    if (actor.type !== "user") return false;
    if (connection.plane === "host" || connection.plane === "team") return actor.role === "owner";
    return connection.ownerId === actor.id;
  }

  private canUseModelConnection(actor: Actor, connectionId: string, modelId = "*") {
    const connection = this.modelConnection(connectionId);
    if (!connection || actor.type === "api_key") return false;
    if (actor.type === "local") return true;
    if (connection.plane === "user") return connection.ownerId === actor.id;
    if (actor.role === "owner") return true;
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM host_model_entitlement
       WHERE connection_id = ? AND (? = '*' OR model_id = '*' OR model_id = ?)
         AND ((subject_type = 'user' AND subject_id = ?)
           OR (subject_type = 'team' AND subject_id = ?)) LIMIT 1`,
        )
        .get(connectionId, modelId, modelId, actor.id, TEAM_ID),
    );
  }

  private modelCredentialAllowed(kind: ModelCredentialKind) {
    if (!this.configFlag(kind === "byok" ? "allow_byok" : "allow_byos")) return false;
    const column = kind === "byok" ? "allow_byok" : "allow_byos";
    const row = this.database
      .prepare(`SELECT ${column} AS allowed FROM host_team_model_policy WHERE team_id = ?`)
      .get(TEAM_ID) as { allowed: number } | undefined;
    return row?.allowed !== 0;
  }

  private configFlag(key: "allow_byok" | "allow_byos") {
    const row = this.database
      .prepare("SELECT value FROM host_identity_config WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value !== "0";
  }

  async removeMember(actor: Actor, userId: string, headers: Headers) {
    await this.ready;
    this.requireOwnerUser(actor);
    const membership = this.membership(userId);
    if (!membership) throw new IdentityError("MEMBER_NOT_FOUND", 404, "Member not found");
    if (membership.role === "owner") {
      throw new IdentityError("OWNER_REMOVAL_FORBIDDEN", 409, "The Host owner cannot be removed");
    }
    try {
      await this.auth.api.removeUser({ body: { userId }, headers });
    } catch {
      throw new IdentityError("MEMBER_REMOVE_FAILED", 500, "Member could not be removed");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const removed = this.deleteSubjectGrants("user", userId);
      this.database.prepare("DELETE FROM host_membership WHERE user_id = ?").run(userId);
      if (removed) this.incrementPathPolicyRevision();
      this.audit.record(identityAuditEventTypes.memberRemoved, actor, {
        type: "user",
        id: userId,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async resetMemberPassword(actor: Actor, userId: string, newPassword: string, headers: Headers) {
    await this.ready;
    this.requireOwnerUser(actor);
    const membership = this.membership(userId);
    if (!membership) throw new IdentityError("MEMBER_NOT_FOUND", 404, "Member not found");
    if (membership.role === "owner") {
      throw new IdentityError(
        "OWNER_PASSWORD_RESET_FORBIDDEN",
        409,
        "Use the signed-in password change flow for the Host owner",
      );
    }
    try {
      await this.auth.api.setUserPassword({ body: { userId, newPassword }, headers });
    } catch (error) {
      const statusCode =
        typeof error === "object" && error !== null && "statusCode" in error
          ? (error as { statusCode?: unknown }).statusCode
          : undefined;
      if (statusCode === 400) {
        throw new IdentityError("INVALID_PASSWORD", 400, "Password does not meet requirements");
      }
      throw new IdentityError("PASSWORD_RESET_FAILED", 500, "Password could not be reset");
    }
    try {
      await this.auth.api.revokeUserSessions({ body: { userId }, headers });
    } catch {
      // A reset must never leave old credentials live, even if Better Auth's server API fails.
      this.database.prepare("DELETE FROM session WHERE userId = ?").run(userId);
    }
    this.audit.record(identityAuditEventTypes.memberPasswordReset, actor, {
      type: "user",
      id: userId,
    });
  }

  async listAudit(actor: Actor, options: { limit?: number; beforeId?: number }) {
    await this.ready;
    this.requireOwnerUser(actor);
    return this.audit.list(options);
  }

  private membership(userId: string) {
    return this.database
      .prepare("SELECT user_id, role, can_invite FROM host_membership WHERE user_id = ?")
      .get(userId) as MembershipRow | undefined;
  }

  private resolveApiKey(secret: string): Actor | null {
    const row = this.database
      .prepare(
        `SELECT id, label, role FROM host_api_key
         WHERE secret_hash = ? AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(hashSecret(secret), Date.now()) as ApiKeyRow | undefined;
    return row ? { type: "api_key", id: row.id, displayName: row.label, role: row.role } : null;
  }

  private revokeSessionToken(token: string) {
    this.database.prepare("DELETE FROM session WHERE token = ?").run(token);
  }

  private isRestrictedActor(actor: Actor) {
    return this.pathGrantsMode === "enforced" && actor.role === "member";
  }

  private getAllowedRoots() {
    this.canonicalAllowedRoots ??= canonicalizeAllowedRoots(this.configuredAllowedRoots);
    return this.canonicalAllowedRoots;
  }

  private pathPolicyRevision() {
    const row = this.database
      .prepare("SELECT value FROM host_identity_config WHERE key = 'path_policy_revision'")
      .get() as { value: string } | undefined;
    return Number(row?.value ?? 0);
  }

  private incrementPathPolicyRevision() {
    this.database
      .prepare(
        `UPDATE host_identity_config SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
         WHERE key = 'path_policy_revision'`,
      )
      .run();
    return this.pathPolicyRevision();
  }

  private requireGrantSubject(subjectType: "user" | "api_key", subjectId: string) {
    const found =
      subjectType === "user"
        ? this.database.prepare("SELECT 1 FROM host_membership WHERE user_id = ?").get(subjectId)
        : this.database
            .prepare(
              `SELECT 1 FROM host_api_key
               WHERE id = ? AND revoked_at IS NULL
                 AND (expires_at IS NULL OR expires_at > ?)`,
            )
            .get(subjectId, Date.now());
    if (!found) throw new IdentityError("GRANT_SUBJECT_NOT_FOUND", 404, "Grant subject not found");
  }

  private deleteSubjectGrants(subjectType: "user" | "api_key", subjectId: string) {
    return (
      this.database
        .prepare("DELETE FROM host_path_grant WHERE subject_type = ? AND subject_id = ?")
        .run(subjectType, subjectId).changes > 0
    );
  }

  private requireOwnerUser(actor: Actor) {
    if (actor.type !== "user" || actor.role !== "owner") {
      throw new IdentityError("FORBIDDEN", 403, "Owner access required");
    }
  }
}

function coveringGrantAccess(root: string, grants: { root: string; access: PathGrantAccess }[]) {
  let best: { root: string; access: PathGrantAccess } | undefined;
  for (const grant of grants) {
    if (root === grant.root || root.startsWith(`${grant.root}/`)) {
      if (!best || grant.root.length > best.root.length) best = grant;
    }
  }
  return best?.access;
}

function mergePathGrants(grants: { root: string; access: PathGrantAccess }[]) {
  const merged = new Map<string, PathGrantAccess>();
  for (const grant of grants) {
    const previous = merged.get(grant.root);
    merged.set(grant.root, previous === "write" ? "write" : grant.access);
  }
  return [...merged].map(([root, access]) => ({ root, access }));
}

function sessionRoleRank(role: SessionAccessRole) {
  switch (role) {
    case "view":
      return 1;
    case "run":
      return 2;
    case "admin":
      return 3;
    case "owner":
      return 4;
  }
}

function sessionActionRank(action: SessionAccessAction) {
  switch (action) {
    case "view":
      return 1;
    case "run":
      return 2;
    case "admin":
      return 3;
    case "delete":
      return 4;
  }
}
