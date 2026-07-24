import type { DatabaseSync } from "node:sqlite";
import type { Actor } from "./types.ts";

export const IDENTITY_AUDIT_MAX_ENTRIES = 10_000;
export const IDENTITY_AUDIT_MAX_PAGE_SIZE = 100;

export const identityAuditEventTypes = {
  loginFailed: "auth.login_failed",
  inviteCreated: "invite.created",
  inviteRevoked: "invite.revoked",
  inviteAccepted: "invite.accepted",
  memberRemoved: "member.removed",
  memberPasswordReset: "member.password_reset",
  apiKeyMinted: "api_key.minted",
  apiKeyRevoked: "api_key.revoked",
} as const;

export type IdentityAuditEventType =
  (typeof identityAuditEventTypes)[keyof typeof identityAuditEventTypes];

export type IdentityAuditSubject = {
  type: "invite" | "user" | "api_key";
  id: string;
  displayName?: string | null;
};

type AuditRow = {
  id: number;
  eventType: IdentityAuditEventType;
  timestamp: number;
  actorType: Actor["type"] | "anonymous";
  actorId: string | null;
  actorDisplayName: string | null;
  subjectType: IdentityAuditSubject["type"] | null;
  subjectId: string | null;
  subjectDisplayName: string | null;
};

/**
 * Stores only fixed, display-safe attribution fields. There is deliberately no
 * free-form metadata parameter where credentials or request headers could leak.
 */
export class IdentityAuditLog {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  initialize() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS host_identity_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        actor_display_name TEXT,
        subject_type TEXT,
        subject_id TEXT,
        subject_display_name TEXT
      );
      CREATE INDEX IF NOT EXISTS host_identity_audit_occurred_at
        ON host_identity_audit(occurred_at DESC, id DESC);
      CREATE TRIGGER IF NOT EXISTS host_identity_audit_bound
      AFTER INSERT ON host_identity_audit
      BEGIN
        DELETE FROM host_identity_audit
        WHERE id <= COALESCE((
          SELECT id FROM host_identity_audit
          ORDER BY id DESC
          LIMIT 1 OFFSET ${IDENTITY_AUDIT_MAX_ENTRIES}
        ), 0);
      END;
    `);
    // Also bounds databases created before the trigger was introduced.
    this.database
      .prepare(
        `DELETE FROM host_identity_audit
         WHERE id <= COALESCE((
           SELECT id FROM host_identity_audit ORDER BY id DESC LIMIT 1 OFFSET ?
         ), 0)`,
      )
      .run(IDENTITY_AUDIT_MAX_ENTRIES);
  }

  record(eventType: IdentityAuditEventType, actor: Actor | null, subject?: IdentityAuditSubject) {
    this.database
      .prepare(
        `INSERT INTO host_identity_audit
          (event_type, occurred_at, actor_type, actor_id, actor_display_name,
           subject_type, subject_id, subject_display_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventType,
        Date.now(),
        actor?.type ?? "anonymous",
        actor?.id ?? null,
        actor?.displayName || null,
        subject?.type ?? null,
        subject?.id ?? null,
        subject?.displayName || null,
      );
  }

  list(options: { limit?: number; beforeId?: number } = {}) {
    const limit = Math.max(
      1,
      Math.min(IDENTITY_AUDIT_MAX_PAGE_SIZE, Math.floor(options.limit ?? 50)),
    );
    const rows = this.database
      .prepare(
        `SELECT id, event_type AS eventType, occurred_at AS timestamp,
                actor_type AS actorType, actor_id AS actorId,
                actor_display_name AS actorDisplayName,
                subject_type AS subjectType, subject_id AS subjectId,
                subject_display_name AS subjectDisplayName
         FROM host_identity_audit
         WHERE (? IS NULL OR id < ?)
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(options.beforeId ?? null, options.beforeId ?? null, limit + 1) as AuditRow[];
    const hasMore = rows.length > limit;
    const events = hasMore ? rows.slice(0, limit) : rows;
    return {
      events,
      nextCursor: hasMore ? (events.at(-1)?.id ?? null) : null,
    };
  }
}
