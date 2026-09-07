import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { IdentityError } from "./errors.ts";
import type { Actor } from "./types.ts";

export const EVERYONE_TEAM_ID = "host_default";
export type HostTeam = {
  id: string;
  name: string;
  memberIds: string[];
  modelOfferingIds: string[];
  allowByok: boolean;
  allowByos: boolean;
};
export type TeamInput = Omit<HostTeam, "id" | "modelOfferingIds"> & { modelOfferingIds?: string[] };

/** Named membership is separate from Host roles. Everyone remains an implicit, compatible group. */
export class TeamDirectory {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS host_team (
        id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE
      );
      INSERT OR IGNORE INTO host_team (id, name) VALUES ('host_default', 'Everyone');
      CREATE TABLE IF NOT EXISTS host_team_member (
        team_id TEXT NOT NULL REFERENCES host_team(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES host_membership(user_id) ON DELETE CASCADE,
        PRIMARY KEY(team_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS host_team_member_user ON host_team_member(user_id);
    `);
  }

  exists(id: string) {
    return !!this.db.prepare("SELECT 1 FROM host_team WHERE id = ?").get(id);
  }

  principals() {
    return this.db
      .prepare("SELECT id, name FROM host_team ORDER BY name COLLATE NOCASE")
      .all() as Array<{ id: string; name: string }>;
  }

  ids(actor: Actor) {
    const named =
      actor.type === "user"
        ? (this.db
            .prepare("SELECT team_id AS id FROM host_team_member WHERE user_id = ?")
            .all(actor.id) as Array<{ id: string }>)
        : [];
    return [EVERYONE_TEAM_ID, ...named.map((row) => row.id)];
  }

  policy(actor: Actor) {
    const rows = this.db
      .prepare(`SELECT allow_byok AS byok, allow_byos AS byos
      FROM host_team_model_policy WHERE team_id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(this.ids(actor))) as Array<{ byok: number; byos: number }>;
    return {
      allowByok: rows.every((row) => row.byok !== 0),
      allowByos: rows.every((row) => row.byos !== 0),
    };
  }

  list(): HostTeam[] {
    return this.principals().map((team) => {
      const members = this.db
        .prepare(
          team.id === EVERYONE_TEAM_ID
            ? "SELECT user_id AS id FROM host_membership ORDER BY user_id"
            : "SELECT user_id AS id FROM host_team_member WHERE team_id = ? ORDER BY user_id",
        )
        .all(...(team.id === EVERYONE_TEAM_ID ? [] : [team.id])) as Array<{ id: string }>;
      const policy = this.db
        .prepare(
          "SELECT allow_byok AS byok, allow_byos AS byos FROM host_team_model_policy WHERE team_id = ?",
        )
        .get(team.id) as { byok: number; byos: number };
      const offerings = this.db
        .prepare(
          "SELECT offering_id AS id FROM host_model_offering_entitlement WHERE subject_type = 'team' AND subject_id = ? ORDER BY offering_id",
        )
        .all(team.id) as Array<{ id: string }>;
      return {
        ...team,
        modelOfferingIds: offerings.map((offering) => offering.id),
        memberIds: members.map((member) => member.id),
        allowByok: policy.byok === 1,
        allowByos: policy.byos === 1,
      };
    });
  }

  save(input: TeamInput, actorId: string, id: string = randomUUID()): HostTeam {
    const name = input.name.trim();
    if (!name || name.length > 80)
      throw new IdentityError("INVALID_TEAM", 400, "Team name must contain 1 to 80 characters");
    const duplicate = this.db
      .prepare("SELECT id FROM host_team WHERE name = ? COLLATE NOCASE AND id <> ?")
      .get(name, id);
    if (duplicate)
      throw new IdentityError("TEAM_NAME_EXISTS", 409, "A team with this name already exists");
    const memberIds = [...new Set(input.memberIds)];
    for (const userId of memberIds) {
      if (!this.db.prepare("SELECT 1 FROM host_membership WHERE user_id = ?").get(userId))
        throw new IdentityError("MEMBER_NOT_FOUND", 400, "Unknown team member");
    }
    const modelOfferingIds = input.modelOfferingIds
      ? [...new Set(input.modelOfferingIds)]
      : undefined;
    for (const offeringId of modelOfferingIds ?? []) {
      if (
        !this.db
          .prepare(
            "SELECT 1 FROM host_model_offering o JOIN host_model_connection b ON b.id = o.backend_id AND b.plane <> 'user' WHERE o.id = ?",
          )
          .get(offeringId)
      )
        throw new IdentityError("MODEL_OFFERING_NOT_FOUND", 400, "Unknown shared model");
    }
    if (id === EVERYONE_TEAM_ID && name !== "Everyone")
      throw new IdentityError("DEFAULT_TEAM_LOCKED", 409, "Everyone cannot be renamed");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO host_team (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name",
        )
        .run(id, name);
      this.db
        .prepare(`INSERT INTO host_team_model_policy (team_id, allow_byok, allow_byos, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(team_id) DO UPDATE SET allow_byok = excluded.allow_byok, allow_byos = excluded.allow_byos, updated_at = excluded.updated_at`)
        .run(id, Number(input.allowByok), Number(input.allowByos), Date.now());
      this.db.prepare("DELETE FROM host_team_member WHERE team_id = ?").run(id);
      if (id !== EVERYONE_TEAM_ID) {
        const insert = this.db.prepare(
          "INSERT INTO host_team_member (team_id, user_id) VALUES (?, ?)",
        );
        for (const userId of memberIds) insert.run(id, userId);
      }
      if (modelOfferingIds) {
        this.db
          .prepare(
            "DELETE FROM host_model_offering_entitlement WHERE subject_type = 'team' AND subject_id = ?",
          )
          .run(id);
        const grant = this.db.prepare(
          "INSERT INTO host_model_offering_entitlement (offering_id, subject_type, subject_id, created_by_user_id, created_at) VALUES (?, 'team', ?, ?, ?)",
        );
        for (const offeringId of modelOfferingIds) grant.run(offeringId, id, actorId, Date.now());
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.list().find((team) => team.id === id)!;
  }

  remove(id: string) {
    if (id === EVERYONE_TEAM_ID)
      throw new IdentityError("DEFAULT_TEAM_LOCKED", 409, "Everyone cannot be deleted");
    if (!this.exists(id)) throw new IdentityError("TEAM_NOT_FOUND", 404, "Team not found");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("DELETE FROM host_session_share WHERE grantee_type = 'team' AND grantee_id = ?")
        .run(id);
      this.db
        .prepare(
          "DELETE FROM host_model_entitlement WHERE subject_type = 'team' AND subject_id = ?",
        )
        .run(id);
      this.db
        .prepare(
          "DELETE FROM host_model_offering_entitlement WHERE subject_type = 'team' AND subject_id = ?",
        )
        .run(id);
      this.db.prepare("DELETE FROM host_team_model_policy WHERE team_id = ?").run(id);
      this.db.prepare("DELETE FROM host_team_member WHERE team_id = ?").run(id);
      this.db.prepare("DELETE FROM host_team WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
