import type { HarnessId, QueueMode, SelectedModel } from "@opengui/protocol";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SETTINGS_FILE = "settings.json";
const LEGACY_PROJECTS_JSON = "projects.json";
const PROMPT_QUEUE_FILE = "prompt-queue.json";
const SQLITE_FILE = "opengui.sqlite";

export interface PromptQueueEntryRecord {
  id: string;
  sessionId: string;
  harnessId: HarnessId;
  projectDirectory: string;
  harnessSessionId: string;
  text: string;
  createdAt: number;
  model?: SelectedModel;
  agent?: string;
  variant?: string;
  mode: QueueMode;
  order: number;
}

export interface CreatePromptQueueEntryInput {
  id?: string;
  sessionId: string;
  harnessId: HarnessId;
  projectDirectory: string;
  harnessSessionId: string;
  text: string;
  createdAt?: number;
  model?: SelectedModel;
  agent?: string;
  variant?: string;
  mode: QueueMode;
  order?: number;
}

export interface UpdatePromptQueueEntryInput {
  text?: string;
  model?: SelectedModel;
  agent?: string | null;
  variant?: string | null;
  mode?: QueueMode;
  order?: number;
}

export interface StorageService {
  listPromptQueue(sessionId?: string): Promise<PromptQueueEntryRecord[]>;
  createPromptQueueEntry(input: CreatePromptQueueEntryInput): Promise<PromptQueueEntryRecord>;
  updatePromptQueueEntry(
    id: string,
    input: UpdatePromptQueueEntryInput,
  ): Promise<PromptQueueEntryRecord | null>;
  deletePromptQueueEntry(id: string): Promise<boolean>;
  deletePromptQueueBySession(sessionId: string): Promise<PromptQueueEntryRecord[]>;
  migratePromptQueueSessionId(oldSessionId: string, newSessionId: string): Promise<number>;
  replacePromptQueue(
    sessionId: string,
    entries: PromptQueueEntryRecord[],
  ): Promise<PromptQueueEntryRecord[]>;

  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<boolean>;
  removeSetting(key: string): Promise<boolean>;
  getAllSettings(): Promise<Record<string, string>>;
  mergeSettings(entries: Record<string, string>): Promise<boolean>;
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function generatePromptQueueEntryId(): string {
  return createId("queue");
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function loadSettingsFile(filePath: string): Record<string, string> {
  const parsed = readJson<unknown>(filePath, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const values =
    "values" in parsed &&
    parsed.values &&
    typeof parsed.values === "object" &&
    !Array.isArray(parsed.values)
      ? parsed.values
      : parsed;

  const settings: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof key !== "string" || typeof value !== "string") continue;
    settings[key] = value;
  }
  return settings;
}

function writeJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, filePath);
}

function normalizeQueueEntries(entries: PromptQueueEntryRecord[]): PromptQueueEntryRecord[] {
  return [...entries]
    .sort((left, right) => left.order - right.order || left.createdAt - right.createdAt)
    .map((entry, index) => ({ ...entry, order: index }));
}

function hasLegacyJsonStorage(dataDir: string): boolean {
  return [LEGACY_PROJECTS_JSON, SETTINGS_FILE, PROMPT_QUEUE_FILE].some((file) =>
    existsSync(join(dataDir, file)),
  );
}

function sqliteTableNames(db: { prepare: (sql: string) => { all: () => unknown[] } }): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name?: unknown;
  }>;
  return new Set(rows.map((row) => String(row.name)));
}

function sqlitePromptQueueColumnNames(db: {
  prepare: (sql: string) => { all: () => unknown[] };
}): Set<string> {
  const rows = db.prepare("PRAGMA table_info(prompt_queue)").all() as Array<{ name?: unknown }>;
  return new Set(rows.map((row) => String(row.name)));
}

const PROMPT_QUEUE_TABLE_SQL = `
  CREATE TABLE prompt_queue (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    harness_id TEXT NOT NULL,
    project_directory TEXT NOT NULL,
    harness_session_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    model_json TEXT,
    agent TEXT,
    variant TEXT,
    mode TEXT NOT NULL,
    entry_order INTEGER NOT NULL
  );
`;

function promptQueueSchemaIsCurrent(columns: Set<string>): boolean {
  const required = [
    "harness_id",
    "project_directory",
    "harness_session_id",
    "model_json",
    "entry_order",
  ];
  if (!required.every((name) => columns.has(name))) return false;
  if (columns.has("queue_order")) return false;
  return true;
}

type SqliteSchemaDb = {
  exec: (sql: string) => void;
  prepare: (sql: string) => { all: () => unknown[] };
};

/** Rebuilds pre-v0.5.25 prompt_queue tables onto the current schema. */
function migrateLegacyPromptQueueSchema(db: SqliteSchemaDb): void {
  const tables = sqliteTableNames(db);
  if (!tables.has("prompt_queue")) return;

  const columns = sqlitePromptQueueColumnNames(db);
  if (promptQueueSchemaIsCurrent(columns)) return;

  const tablesNow = sqliteTableNames(db);
  const hasSessions = tablesNow.has("sessions");
  const hasProjects = tablesNow.has("projects");

  const harnessIdExpr = columns.has("harness_id")
    ? "COALESCE(NULLIF(pq.harness_id, ''), s.harness_id, 'unknown')"
    : "COALESCE(s.harness_id, 'unknown')";
  const harnessSessionExpr = columns.has("harness_session_id")
    ? "COALESCE(NULLIF(pq.harness_session_id, ''), s.raw_id, '')"
    : "COALESCE(s.raw_id, '')";
  const projectDirectoryExpr =
    hasSessions && hasProjects
      ? columns.has("project_directory")
        ? "COALESCE(NULLIF(pq.project_directory, ''), NULLIF(p.canonical_path, ''), NULLIF(p.path, ''), '')"
        : "COALESCE(NULLIF(p.canonical_path, ''), NULLIF(p.path, ''), '')"
      : columns.has("project_directory")
        ? "COALESCE(pq.project_directory, '')"
        : "''";
  const entryOrderExpr = columns.has("entry_order")
    ? columns.has("queue_order")
      ? "COALESCE(pq.entry_order, pq.queue_order, 0)"
      : "COALESCE(pq.entry_order, 0)"
    : columns.has("queue_order")
      ? "COALESCE(pq.queue_order, 0)"
      : "0";
  const modelJsonExpr = columns.has("model_json") ? "pq.model_json" : "NULL";
  const agentExpr = columns.has("agent") ? "pq.agent" : "NULL";
  const variantExpr = columns.has("variant") ? "pq.variant" : "NULL";

  const sessionJoin = hasSessions ? "LEFT JOIN sessions s ON s.id = pq.session_id" : "";
  const projectJoin =
    hasSessions && hasProjects ? "LEFT JOIN projects p ON p.id = s.project_id" : "";

  db.exec("ALTER TABLE prompt_queue RENAME TO prompt_queue_legacy");
  db.exec(PROMPT_QUEUE_TABLE_SQL);
  db.exec(`
    INSERT INTO prompt_queue (
      id, session_id, harness_id, project_directory, harness_session_id,
      text, created_at, model_json, agent, variant, mode, entry_order
    )
    SELECT
      pq.id,
      pq.session_id,
      ${harnessIdExpr},
      ${projectDirectoryExpr},
      ${harnessSessionExpr},
      pq.text,
      pq.created_at,
      ${modelJsonExpr},
      ${agentExpr},
      ${variantExpr},
      pq.mode,
      ${entryOrderExpr}
    FROM prompt_queue_legacy pq
    ${sessionJoin}
    ${projectJoin};
  `);
  db.exec("DROP TABLE prompt_queue_legacy");
}

export function createJsonStorageService(dataDir: string): StorageService {
  mkdirSync(dataDir, { recursive: true });

  const settingsPath = join(dataDir, SETTINGS_FILE);
  const promptQueuePath = join(dataDir, PROMPT_QUEUE_FILE);

  function loadPromptQueue(): PromptQueueEntryRecord[] {
    return normalizeQueueEntries(readJson<PromptQueueEntryRecord[]>(promptQueuePath, []));
  }

  function savePromptQueue(entries: PromptQueueEntryRecord[]): void {
    writeJson(promptQueuePath, normalizeQueueEntries(entries));
  }

  function loadSettings(): Record<string, string> {
    return loadSettingsFile(settingsPath);
  }

  function saveSettings(settings: Record<string, string>): void {
    writeJson(settingsPath, settings);
  }

  return {
    async listPromptQueue(sessionId?: string) {
      const entries = loadPromptQueue();
      return sessionId ? entries.filter((entry) => entry.sessionId === sessionId) : entries;
    },

    async createPromptQueueEntry(input: CreatePromptQueueEntryInput) {
      const existing = loadPromptQueue();
      const nextOrder =
        input.order ?? existing.filter((entry) => entry.sessionId === input.sessionId).length;
      const entry: PromptQueueEntryRecord = {
        id: input.id ?? generatePromptQueueEntryId(),
        sessionId: input.sessionId,
        harnessId: input.harnessId,
        projectDirectory: input.projectDirectory,
        harnessSessionId: input.harnessSessionId,
        text: input.text,
        createdAt: input.createdAt ?? Date.now(),
        model: input.model,
        agent: input.agent,
        variant: input.variant,
        mode: input.mode,
        order: nextOrder,
      };
      existing.push(entry);
      savePromptQueue(existing);
      return (
        normalizeQueueEntries(existing.filter((item) => item.sessionId === input.sessionId)).find(
          (item) => item.id === entry.id,
        ) ?? entry
      );
    },

    async updatePromptQueueEntry(id: string, input: UpdatePromptQueueEntryInput) {
      const entries = loadPromptQueue();
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) return null;
      const existing = entries[index]!;
      const updated: PromptQueueEntryRecord = {
        ...existing,
        text: input.text ?? existing.text,
        model: input.model ?? existing.model,
        agent: input.agent === undefined ? existing.agent : (input.agent ?? undefined),
        variant: input.variant === undefined ? existing.variant : (input.variant ?? undefined),
        mode: input.mode ?? existing.mode,
        order: input.order ?? existing.order,
      };
      entries[index] = updated;
      savePromptQueue(entries);
      return (
        normalizeQueueEntries(
          loadPromptQueue().filter((entry) => entry.sessionId === updated.sessionId),
        ).find((entry) => entry.id === id) ?? updated
      );
    },

    async deletePromptQueueEntry(id: string) {
      const entries = loadPromptQueue();
      const next = entries.filter((entry) => entry.id !== id);
      if (next.length === entries.length) return false;
      savePromptQueue(next);
      return true;
    },

    async deletePromptQueueBySession(sessionId: string) {
      const entries = loadPromptQueue();
      const removed = entries.filter((entry) => entry.sessionId === sessionId);
      if (removed.length === 0) return [];
      savePromptQueue(entries.filter((entry) => entry.sessionId !== sessionId));
      return normalizeQueueEntries(removed);
    },

    async migratePromptQueueSessionId(oldSessionId: string, newSessionId: string) {
      const entries = loadPromptQueue();
      let count = 0;
      for (const entry of entries) {
        if (entry.sessionId === oldSessionId) {
          entry.sessionId = newSessionId;
          count++;
        }
      }
      if (count > 0) savePromptQueue(entries);
      return count;
    },

    async replacePromptQueue(sessionId: string, entries: PromptQueueEntryRecord[]) {
      const current = loadPromptQueue().filter((entry) => entry.sessionId !== sessionId);
      const next = normalizeQueueEntries(entries.filter((entry) => entry.sessionId === sessionId));
      savePromptQueue([...current, ...next]);
      return next;
    },

    async getSetting(key: string) {
      return loadSettings()[key] ?? null;
    },

    async setSetting(key: string, value: string) {
      const settings = loadSettings();
      settings[key] = value;
      saveSettings(settings);
      return true;
    },

    async removeSetting(key: string) {
      const settings = loadSettings();
      if (!(key in settings)) return true;
      delete settings[key];
      saveSettings(settings);
      return true;
    },

    async getAllSettings() {
      return loadSettings();
    },

    async mergeSettings(entries: Record<string, string>) {
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) return false;
      const settings = loadSettings();
      let changed = false;
      for (const [key, value] of Object.entries(entries)) {
        if (typeof key !== "string" || typeof value !== "string") continue;
        if (settings[key] === value) continue;
        settings[key] = value;
        changed = true;
      }
      if (changed) saveSettings(settings);
      return true;
    },
  };
}

export async function createSqliteStorageService(dataDir: string): Promise<StorageService> {
  mkdirSync(dataDir, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(dataDir, SQLITE_FILE));
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_queue (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      harness_id TEXT NOT NULL,
      project_directory TEXT NOT NULL,
      harness_session_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      model_json TEXT,
      agent TEXT,
      variant TEXT,
      mode TEXT NOT NULL,
      entry_order INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  migrateLegacyPromptQueueSchema(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS prompt_queue_session_order
      ON prompt_queue(session_id, entry_order, created_at);
  `);

  const parseJson = <T>(value: unknown): T | undefined => {
    if (typeof value !== "string" || !value) return undefined;
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  };
  const queueFromRow = (row: Record<string, unknown>): PromptQueueEntryRecord => ({
    id: String(row.id),
    sessionId: String(row.session_id),
    harnessId: String(row.harness_id) as HarnessId,
    projectDirectory: String(row.project_directory),
    harnessSessionId: String(row.harness_session_id),
    text: String(row.text),
    createdAt: Number(row.created_at),
    model: parseJson<SelectedModel>(row.model_json),
    agent: typeof row.agent === "string" ? row.agent : undefined,
    variant: typeof row.variant === "string" ? row.variant : undefined,
    mode: String(row.mode) as QueueMode,
    order: Number(row.entry_order),
  });

  const service: StorageService = {
    async listPromptQueue(sessionId?: string) {
      const rows = sessionId
        ? db
            .prepare(
              `SELECT * FROM prompt_queue
               WHERE session_id = ?
               ORDER BY entry_order ASC, created_at ASC`,
            )
            .all(sessionId)
        : db
            .prepare(
              `SELECT * FROM prompt_queue
               ORDER BY session_id ASC, entry_order ASC, created_at ASC`,
            )
            .all();
      return normalizeQueueEntries(rows.map((row) => queueFromRow(row as Record<string, unknown>)));
    },
    async createPromptQueueEntry(input: CreatePromptQueueEntryInput) {
      const current = await service.listPromptQueue(input.sessionId);
      const entry: PromptQueueEntryRecord = {
        id: input.id ?? generatePromptQueueEntryId(),
        sessionId: input.sessionId,
        harnessId: input.harnessId,
        projectDirectory: input.projectDirectory,
        harnessSessionId: input.harnessSessionId,
        text: input.text,
        createdAt: input.createdAt ?? Date.now(),
        model: input.model,
        agent: input.agent,
        variant: input.variant,
        mode: input.mode,
        order: input.order ?? current.length,
      };
      db.prepare(
        `INSERT INTO prompt_queue (id, session_id, harness_id, project_directory, harness_session_id, text, created_at, model_json, agent, variant, mode, entry_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        entry.id,
        entry.sessionId,
        entry.harnessId,
        entry.projectDirectory,
        entry.harnessSessionId,
        entry.text,
        entry.createdAt,
        entry.model ? JSON.stringify(entry.model) : null,
        entry.agent ?? null,
        entry.variant ?? null,
        entry.mode,
        entry.order,
      );
      return entry;
    },
    async updatePromptQueueEntry(id: string, input: UpdatePromptQueueEntryInput) {
      const row = db.prepare("SELECT * FROM prompt_queue WHERE id = ?").get(id);
      if (!row) return null;
      const existing = queueFromRow(row as Record<string, unknown>);
      const updated = {
        ...existing,
        text: input.text ?? existing.text,
        model: input.model ?? existing.model,
        agent: input.agent === undefined ? existing.agent : (input.agent ?? undefined),
        variant: input.variant === undefined ? existing.variant : (input.variant ?? undefined),
        mode: input.mode ?? existing.mode,
        order: input.order ?? existing.order,
      };
      db.prepare(
        `UPDATE prompt_queue SET text = ?, model_json = ?, agent = ?, variant = ?, mode = ?, entry_order = ? WHERE id = ?`,
      ).run(
        updated.text,
        updated.model ? JSON.stringify(updated.model) : null,
        updated.agent ?? null,
        updated.variant ?? null,
        updated.mode,
        updated.order,
        id,
      );
      return updated;
    },
    async deletePromptQueueEntry(id: string) {
      return db.prepare("DELETE FROM prompt_queue WHERE id = ?").run(id).changes > 0;
    },
    async deletePromptQueueBySession(sessionId: string) {
      const removed = await service.listPromptQueue(sessionId);
      db.prepare("DELETE FROM prompt_queue WHERE session_id = ?").run(sessionId);
      return removed;
    },
    async migratePromptQueueSessionId(oldSessionId: string, newSessionId: string) {
      const result = db
        .prepare("UPDATE prompt_queue SET session_id = ? WHERE session_id = ?")
        .run(newSessionId, oldSessionId);
      return Number(result.changes);
    },
    async replacePromptQueue(sessionId: string, entries: PromptQueueEntryRecord[]) {
      await service.deletePromptQueueBySession(sessionId);
      for (const entry of normalizeQueueEntries(entries))
        await service.createPromptQueueEntry(entry);
      return await service.listPromptQueue(sessionId);
    },
    async getSetting(key: string) {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
        | { value?: string }
        | undefined;
      return row?.value ?? null;
    },
    async setSetting(key: string, value: string) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
      return true;
    },
    async removeSetting(key: string) {
      db.prepare("DELETE FROM settings WHERE key = ?").run(key);
      return true;
    },
    async getAllSettings() {
      return Object.fromEntries(
        db
          .prepare("SELECT key, value FROM settings")
          .all()
          .map((row) => {
            const item = row as { key: string; value: string };
            return [item.key, item.value];
          }),
      );
    },
    async mergeSettings(entries: Record<string, string>) {
      for (const [key, value] of Object.entries(entries)) await service.setSetting(key, value);
      return true;
    },
  };
  return service;
}

async function migrateJsonStorageToSqlite(dataDir: string, storage: StorageService): Promise<void> {
  const legacy = createJsonStorageService(dataDir);
  const [settings, queue] = await Promise.all([legacy.getAllSettings(), legacy.listPromptQueue()]);

  for (const entry of queue) {
    await storage.createPromptQueueEntry(entry);
  }

  await storage.mergeSettings(settings);
}

export async function createStorageService(dataDir: string): Promise<StorageService> {
  const preferred = (process.env.OPENGUI_STORAGE ?? "sqlite").trim().toLowerCase();
  if (preferred === "json") return createJsonStorageService(dataDir);

  const sqlitePath = join(dataDir, SQLITE_FILE);
  const sqliteExists = existsSync(sqlitePath);
  const storage = await createSqliteStorageService(dataDir);
  if (!sqliteExists && hasLegacyJsonStorage(dataDir)) {
    await migrateJsonStorageToSqlite(dataDir, storage);
  }
  return storage;
}
