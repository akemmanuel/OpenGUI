import { type Kysely, sql } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";

const initialSessionLog: Migration = {
  async up(database: Kysely<unknown>) {
    await sql`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_directory TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `.execute(database);

    const columns = await sql<{ name: string }>`PRAGMA table_info(sessions)`.execute(database);
    const columnNames = new Set(columns.rows.map((column) => column.name));

    // Compatibility with the first unreleased v1 schema. Selection is now
    // represented by ordered model_changed/reasoning_changed entries.
    if (columnNames.has("model_json")) {
      await sql`ALTER TABLE sessions DROP COLUMN model_json`.execute(database);
    }
    if (columnNames.has("reasoning")) {
      await sql`ALTER TABLE sessions DROP COLUMN reasoning`.execute(database);
    }

    await sql`
      CREATE INDEX IF NOT EXISTS sessions_project_updated
      ON sessions(project_directory, updated_at DESC, id DESC)
    `.execute(database);
    await sql`
      CREATE TABLE IF NOT EXISTS session_entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      )
    `.execute(database);
    await sql`
      CREATE TABLE IF NOT EXISTS session_follow_ups (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        prompt_json TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      )
    `.execute(database);
    await sql`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      )
    `.execute(database);
  },
  async down(database: Kysely<unknown>) {
    await sql`DROP TABLE IF EXISTS session_follow_ups`.execute(database);
    await sql`DROP TABLE IF EXISTS session_entries`.execute(database);
    await sql`DROP TABLE IF EXISTS settings`.execute(database);
    await sql`DROP TABLE IF EXISTS sessions`.execute(database);
  },
};

const migrations: Record<string, Migration> = {
  "2026-07-10T00-00-00_initial-session-log": initialSessionLog,
};

export class HarnessMigrationProvider implements MigrationProvider {
  async getMigrations() {
    return migrations;
  }
}
