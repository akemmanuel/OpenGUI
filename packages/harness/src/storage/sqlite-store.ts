import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Kysely, sql, type Transaction } from "kysely";
import { Migrator } from "kysely/migration";
import { NodeNativeSqliteDialect } from "kysely-node-native-sqlite";
import type {
  CreateSessionInput,
  FollowUp,
  IdGenerator,
  ModelSelection,
  ReasoningLevel,
  SessionEntry,
  SessionEntryKind,
  SessionStatus,
  SessionSummary,
} from "../harness.ts";
import { HarnessMigrationProvider } from "./migrations.ts";
import type {
  HarnessDatabase,
  SessionEntryTable,
  SessionFollowUpTable,
  SessionTable,
} from "./schema.ts";

export const HARNESS_DATABASE_FILENAME = "opengui-harness-v1.sqlite";

function statusFromEntries(entries: SessionEntry[]): SessionStatus {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    switch (entries[index]?.kind) {
      case "run_started":
        return "running";
      case "run_failed":
        return "failed";
      case "run_interrupted":
        return "interrupted";
      case "run_aborted":
        return "stopped";
      case "run_completed":
        return "idle";
      default:
        break;
    }
  }
  return "idle";
}

function decodeEntry(row: SessionEntryTable): SessionEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    sequence: Number(row.sequence),
    kind: row.kind as SessionEntryKind,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function decodeFollowUp(
  row: Pick<SessionFollowUpTable, "id" | "sequence" | "prompt_json" | "created_at">,
): FollowUp {
  return {
    id: row.id,
    sequence: Number(row.sequence),
    prompt: JSON.parse(row.prompt_json) as { text: string },
    createdAt: row.created_at,
  };
}

export class SqliteSessionStore {
  readonly databasePath: string;
  readonly #database: Kysely<HarnessDatabase>;
  readonly #ids: IdGenerator;
  readonly #ready: Promise<void>;

  constructor(dataDirectory: string, ids: IdGenerator) {
    mkdirSync(dataDirectory, { recursive: true });
    this.databasePath = join(dataDirectory, HARNESS_DATABASE_FILENAME);
    this.#ids = ids;
    this.#database = new Kysely<HarnessDatabase>({
      dialect: new NodeNativeSqliteDialect(this.databasePath),
    });
    this.#ready = this.#initialize();
  }

  async #initialize() {
    await sql`PRAGMA foreign_keys = ON`.execute(this.#database);
    await sql`PRAGMA journal_mode = WAL`.execute(this.#database);
    const migrator = new Migrator({
      db: this.#database,
      provider: new HarnessMigrationProvider(),
    });
    const result = await migrator.migrateToLatest();
    if (result.error) throw result.error;
    const failed = result.results?.find((migration) => migration.status === "Error");
    if (failed) throw new Error(`Harness migration failed: ${failed.migrationName}`);
  }

  async #insertEntry(
    transaction: Transaction<HarnessDatabase>,
    sessionId: string,
    sequence: number,
    kind: SessionEntryKind,
    payload: Record<string, unknown>,
    now: string,
  ) {
    const entry: SessionEntry = {
      id: this.#ids.next("entry"),
      sessionId,
      sequence,
      kind,
      payload,
      createdAt: now,
    };
    await transaction
      .insertInto("session_entries")
      .values({
        id: entry.id,
        session_id: sessionId,
        sequence,
        kind,
        payload_json: JSON.stringify(payload),
        created_at: now,
      })
      .executeTakeFirstOrThrow();
    return entry;
  }

  async createSession(input: CreateSessionInput, sessionId: string, now: string) {
    await this.#ready;
    return this.#database.transaction().execute(async (transaction) => {
      const title = input.title?.trim() || "New session";
      await transaction
        .insertInto("sessions")
        .values({
          id: sessionId,
          project_directory: input.projectDirectory,
          title,
          created_at: now,
          updated_at: now,
        })
        .executeTakeFirstOrThrow();
      return [
        await this.#insertEntry(transaction, sessionId, 1, "session_created", { title }, now),
        await this.#insertEntry(
          transaction,
          sessionId,
          2,
          "model_changed",
          { model: input.model },
          now,
        ),
        await this.#insertEntry(
          transaction,
          sessionId,
          3,
          "reasoning_changed",
          { reasoning: input.reasoning },
          now,
        ),
      ];
    });
  }

  async appendEntry(
    sessionId: string,
    kind: SessionEntryKind,
    payload: Record<string, unknown>,
    now: string,
  ) {
    await this.#ready;
    return this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("session_entries")
        .select(sql<number>`coalesce(max(sequence), 0)`.as("sequence"))
        .where("session_id", "=", sessionId)
        .executeTakeFirstOrThrow();
      const entry = await this.#insertEntry(
        transaction,
        sessionId,
        Number(row.sequence) + 1,
        kind,
        payload,
        now,
      );
      await transaction
        .updateTable("sessions")
        .set({ updated_at: now })
        .where("id", "=", sessionId)
        .executeTakeFirst();
      return entry;
    });
  }

  async beginRun(input: {
    sessionId: string;
    runId: string;
    text: string;
    model: ModelSelection;
    reasoning: ReasoningLevel;
    followUpId?: string;
    now: string;
  }): Promise<[SessionEntry, SessionEntry]> {
    await this.#ready;
    return this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("session_entries")
        .select(sql<number>`coalesce(max(sequence), 0)`.as("sequence"))
        .where("session_id", "=", input.sessionId)
        .executeTakeFirstOrThrow();
      const sequence = Number(row.sequence);
      const userMessage = await this.#insertEntry(
        transaction,
        input.sessionId,
        sequence + 1,
        "user_message",
        {
          runId: input.runId,
          text: input.text,
          model: input.model,
          reasoning: input.reasoning,
          ...(input.followUpId ? { followUpId: input.followUpId } : {}),
        },
        input.now,
      );
      const runStarted = await this.#insertEntry(
        transaction,
        input.sessionId,
        sequence + 2,
        "run_started",
        { runId: input.runId },
        input.now,
      );
      if (input.followUpId) {
        const update = await transaction
          .updateTable("session_follow_ups")
          .set({ state: "completed" })
          .where("id", "=", input.followUpId)
          .where("session_id", "=", input.sessionId)
          .where("state", "=", "dispatched")
          .executeTakeFirst();
        if (update.numUpdatedRows !== 1n)
          throw new Error(`Follow-up is not dispatchable: ${input.followUpId}`);
      }
      await transaction
        .updateTable("sessions")
        .set({ updated_at: input.now })
        .where("id", "=", input.sessionId)
        .executeTakeFirst();
      return [userMessage, runStarted];
    });
  }

  async enqueueFollowUp(sessionId: string, text: string, now: string) {
    await this.#ready;
    return this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("session_follow_ups")
        .select(sql<number>`coalesce(max(sequence), 0)`.as("sequence"))
        .where("session_id", "=", sessionId)
        .executeTakeFirstOrThrow();
      const followUp: FollowUp = {
        id: this.#ids.next("follow_up"),
        sequence: Number(row.sequence) + 1,
        prompt: { text },
        createdAt: now,
      };
      await transaction
        .insertInto("session_follow_ups")
        .values({
          id: followUp.id,
          session_id: sessionId,
          sequence: followUp.sequence,
          prompt_json: JSON.stringify(followUp.prompt),
          state: "pending",
          created_at: now,
        })
        .executeTakeFirstOrThrow();
      return followUp;
    });
  }

  async listFollowUps(sessionId: string) {
    await this.#ready;
    const rows = await this.#database
      .selectFrom("session_follow_ups")
      .select(["id", "sequence", "prompt_json", "created_at"])
      .where("session_id", "=", sessionId)
      .where("state", "in", ["pending", "dispatched"])
      .orderBy("sequence")
      .execute();
    return rows.map(decodeFollowUp);
  }

  async updateFollowUp(sessionId: string, followUpId: string, text: string) {
    await this.#ready;
    const result = await this.#database
      .updateTable("session_follow_ups")
      .set({ prompt_json: JSON.stringify({ text }) })
      .where("session_id", "=", sessionId)
      .where("id", "=", followUpId)
      .where("state", "=", "pending")
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new Error(`Pending follow-up not found: ${followUpId}`);
  }

  async removeFollowUp(sessionId: string, followUpId: string) {
    await this.#ready;
    const result = await this.#database
      .deleteFrom("session_follow_ups")
      .where("session_id", "=", sessionId)
      .where("id", "=", followUpId)
      .where("state", "=", "pending")
      .executeTakeFirst();
    if (result.numDeletedRows !== 1n) throw new Error(`Pending follow-up not found: ${followUpId}`);
  }

  async reorderFollowUp(sessionId: string, followUpId: string, requestedIndex: number) {
    await this.#ready;
    await this.#database.transaction().execute(async (transaction) => {
      const rows = await transaction
        .selectFrom("session_follow_ups")
        .select(["id", "sequence"])
        .where("session_id", "=", sessionId)
        .where("state", "=", "pending")
        .orderBy("sequence")
        .execute();
      const fromIndex = rows.findIndex((row) => row.id === followUpId);
      if (fromIndex < 0) throw new Error(`Pending follow-up not found: ${followUpId}`);
      const toIndex = Math.max(0, Math.min(Math.trunc(requestedIndex), rows.length - 1));
      if (fromIndex === toIndex) return;
      const reordered = [...rows];
      const [moved] = reordered.splice(fromIndex, 1);
      if (!moved) return;
      reordered.splice(toIndex, 0, moved);
      const sequences = rows.map((row) => row.sequence).sort((a, b) => a - b);
      for (let index = 0; index < reordered.length; index += 1) {
        await transaction
          .updateTable("session_follow_ups")
          .set({ sequence: -(index + 1) })
          .where("id", "=", reordered[index]!.id)
          .executeTakeFirstOrThrow();
      }
      for (let index = 0; index < reordered.length; index += 1) {
        await transaction
          .updateTable("session_follow_ups")
          .set({ sequence: sequences[index]! })
          .where("id", "=", reordered[index]!.id)
          .executeTakeFirstOrThrow();
      }
    });
  }

  async claimNextFollowUp(sessionId: string) {
    await this.#ready;
    return this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("session_follow_ups")
        .select(["id", "sequence", "prompt_json", "created_at"])
        .where("session_id", "=", sessionId)
        .where("state", "=", "pending")
        .orderBy("sequence")
        .limit(1)
        .executeTakeFirst();
      if (!row) return null;
      await transaction
        .updateTable("session_follow_ups")
        .set({ state: "dispatched" })
        .where("id", "=", row.id)
        .executeTakeFirst();
      return decodeFollowUp(row);
    });
  }

  async renameSession(sessionId: string, title: string, now: string) {
    await this.#ready;
    await this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("session_entries")
        .select(sql<number>`coalesce(max(sequence), 0)`.as("sequence"))
        .where("session_id", "=", sessionId)
        .executeTakeFirstOrThrow();
      await this.#insertEntry(
        transaction,
        sessionId,
        Number(row.sequence) + 1,
        "session_renamed",
        { title },
        now,
      );
      await transaction
        .updateTable("sessions")
        .set({ title, updated_at: now })
        .where("id", "=", sessionId)
        .executeTakeFirst();
    });
  }

  async deleteSession(sessionId: string) {
    await this.#ready;
    const result = await this.#database
      .deleteFrom("sessions")
      .where("id", "=", sessionId)
      .executeTakeFirst();
    if (result.numDeletedRows === 0n) throw new Error(`Session not found: ${sessionId}`);
  }

  async readSession(sessionId: string) {
    await this.#ready;
    const session = await this.#database
      .selectFrom("sessions")
      .selectAll()
      .where("id", "=", sessionId)
      .executeTakeFirst();
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const entries = (
      await this.#database
        .selectFrom("session_entries")
        .selectAll()
        .where("session_id", "=", sessionId)
        .orderBy("sequence")
        .execute()
    ).map(decodeEntry);
    return { summary: this.#summary(session, entries), entries };
  }

  #summary(session: SessionTable, entries: SessionEntry[]): SessionSummary {
    return {
      id: session.id,
      projectDirectory: session.project_directory,
      title: session.title,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      status: statusFromEntries(entries),
    };
  }

  async listSessions(projectDirectory: string) {
    await this.#ready;
    const sessions = await this.#database
      .selectFrom("sessions")
      .selectAll()
      .where("project_directory", "=", projectDirectory)
      .orderBy("updated_at", "desc")
      .orderBy("id", "desc")
      .execute();
    return Promise.all(
      sessions.map(async (session) => {
        const entries = (
          await this.#database
            .selectFrom("session_entries")
            .selectAll()
            .where("session_id", "=", session.id)
            .orderBy("sequence")
            .execute()
        ).map(decodeEntry);
        return this.#summary(session, entries);
      }),
    );
  }

  async recoverInterruptedRuns(now: string) {
    await this.#ready;
    await this.#database
      .updateTable("session_follow_ups")
      .set({ state: "pending" })
      .where("state", "=", "dispatched")
      .execute();
    const sessions = await this.#database.selectFrom("sessions").select("id").execute();
    const terminalKinds = new Set<SessionEntryKind>([
      "run_completed",
      "run_failed",
      "run_aborted",
      "run_interrupted",
    ]);
    for (const session of sessions) {
      const entries = (await this.readSession(session.id)).entries;
      const unfinishedRunIds = new Set<string>();
      for (const entry of entries) {
        const runId = typeof entry.payload.runId === "string" ? entry.payload.runId : null;
        if (!runId) continue;
        if (entry.kind === "run_started") unfinishedRunIds.add(runId);
        if (terminalKinds.has(entry.kind)) unfinishedRunIds.delete(runId);
      }
      for (const runId of unfinishedRunIds) {
        await this.appendEntry(session.id, "run_interrupted", { runId }, now);
      }
    }
  }

  async close() {
    await this.#ready;
    await this.#database.destroy();
  }
}
