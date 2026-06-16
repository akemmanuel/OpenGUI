import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HarnessId } from "../../src/agents/index.ts";
import type { QueueMode } from "../../src/lib/session-drafts.ts";
import type { SelectedModel } from "../../src/types/electron.d.ts";

const PROJECTS_FILE = "projects.json";
const SETTINGS_FILE = "settings.json";
const PROMPT_QUEUE_FILE = "prompt-queue.json";
const SQLITE_FILE = "opengui.sqlite";

export interface ProjectRecord {
  id: string;
  displayName: string;
  path: string;
  canonicalPath: string;
  allowedRootId?: string;
  workspaceId?: string;
  git?: {
    currentBranch?: string;
    remoteUrl?: string;
  };
  createdAt: string;
  updatedAt: string;
}

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

export interface CreateProjectInput {
  displayName: string;
  path: string;
  canonicalPath?: string;
  allowedRootId?: string;
  workspaceId?: string;
  git?: ProjectRecord["git"];
}

export interface UpdateProjectInput {
  displayName?: string;
  path?: string;
  canonicalPath?: string;
  allowedRootId?: string | null;
  git?: ProjectRecord["git"];
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
  listProjects(): Promise<ProjectRecord[]>;
  getProject(id: string): Promise<ProjectRecord | null>;
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;
  updateProject(id: string, input: UpdateProjectInput): Promise<ProjectRecord | null>;
  deleteProject(id: string): Promise<boolean>;

  listPromptQueue(sessionId?: string): Promise<PromptQueueEntryRecord[]>;
  createPromptQueueEntry(input: CreatePromptQueueEntryInput): Promise<PromptQueueEntryRecord>;
  updatePromptQueueEntry(
    id: string,
    input: UpdatePromptQueueEntryInput,
  ): Promise<PromptQueueEntryRecord | null>;
  deletePromptQueueEntry(id: string): Promise<boolean>;
  deletePromptQueueBySession(sessionId: string): Promise<PromptQueueEntryRecord[]>;
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

function generateProjectId(): string {
  return createId("project");
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
  return [PROJECTS_FILE, SETTINGS_FILE, PROMPT_QUEUE_FILE].some((file) =>
    existsSync(join(dataDir, file)),
  );
}

export function createJsonStorageService(dataDir: string): StorageService {
  mkdirSync(dataDir, { recursive: true });

  const projectsPath = join(dataDir, PROJECTS_FILE);
  const settingsPath = join(dataDir, SETTINGS_FILE);
  const promptQueuePath = join(dataDir, PROMPT_QUEUE_FILE);

  function loadProjects(): ProjectRecord[] {
    return readJson<ProjectRecord[]>(projectsPath, []);
  }

  function saveProjects(projects: ProjectRecord[]): void {
    writeJson(projectsPath, projects);
  }

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
    async listProjects() {
      return loadProjects();
    },

    async getProject(id: string) {
      return loadProjects().find((project) => project.id === id) ?? null;
    },

    async createProject(input: CreateProjectInput) {
      const projects = loadProjects();
      const now = new Date().toISOString();
      const project: ProjectRecord = {
        id: generateProjectId(),
        displayName: input.displayName,
        path: input.path,
        canonicalPath: input.canonicalPath ?? input.path,
        allowedRootId: input.allowedRootId,
        workspaceId: input.workspaceId,
        git: input.git,
        createdAt: now,
        updatedAt: now,
      };
      projects.push(project);
      saveProjects(projects);
      return project;
    },

    async updateProject(id: string, input: UpdateProjectInput) {
      const projects = loadProjects();
      const index = projects.findIndex((project) => project.id === id);
      if (index === -1) return null;
      const existing = projects[index]!;
      const updated: ProjectRecord = {
        ...existing,
        displayName: input.displayName ?? existing.displayName,
        path: input.path ?? existing.path,
        canonicalPath: input.canonicalPath ?? existing.canonicalPath,
        allowedRootId:
          input.allowedRootId === undefined
            ? existing.allowedRootId
            : (input.allowedRootId ?? undefined),
        git: input.git ?? existing.git,
        updatedAt: new Date().toISOString(),
      };
      projects[index] = updated;
      saveProjects(projects);
      return updated;
    },

    async deleteProject(id: string) {
      const projects = loadProjects();
      const index = projects.findIndex((project) => project.id === id);
      if (index === -1) return false;
      projects.splice(index, 1);
      saveProjects(projects);
      return true;
    },

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
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      path TEXT NOT NULL,
      canonical_path TEXT NOT NULL,
      allowed_root_id TEXT,
      workspace_id TEXT,
      git_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
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

  const promptQueueColumns = new Set(
    db
      .prepare("PRAGMA table_info(prompt_queue)")
      .all()
      .map((row) => String((row as Record<string, unknown>).name)),
  );
  if (!promptQueueColumns.has("entry_order")) {
    db.exec("ALTER TABLE prompt_queue ADD COLUMN entry_order INTEGER NOT NULL DEFAULT 0");
  }
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
  const projectFromRow = (row: Record<string, unknown>): ProjectRecord => ({
    id: String(row.id),
    displayName: String(row.display_name),
    path: String(row.path),
    canonicalPath: String(row.canonical_path),
    allowedRootId: typeof row.allowed_root_id === "string" ? row.allowed_root_id : undefined,
    workspaceId: typeof row.workspace_id === "string" ? row.workspace_id : undefined,
    git: parseJson<ProjectRecord["git"]>(row.git_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });
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
    async listProjects() {
      return db.prepare("SELECT * FROM projects ORDER BY created_at ASC").all().map(projectFromRow);
    },
    async getProject(id: string) {
      const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
      return row ? projectFromRow(row as Record<string, unknown>) : null;
    },
    async createProject(input: CreateProjectInput) {
      const now = new Date().toISOString();
      const project: ProjectRecord = {
        id: generateProjectId(),
        displayName: input.displayName,
        path: input.path,
        canonicalPath: input.canonicalPath ?? input.path,
        allowedRootId: input.allowedRootId,
        workspaceId: input.workspaceId,
        git: input.git,
        createdAt: now,
        updatedAt: now,
      };
      db.prepare(
        `INSERT INTO projects (id, display_name, path, canonical_path, allowed_root_id, workspace_id, git_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        project.id,
        project.displayName,
        project.path,
        project.canonicalPath,
        project.allowedRootId ?? null,
        project.workspaceId ?? null,
        project.git ? JSON.stringify(project.git) : null,
        project.createdAt,
        project.updatedAt,
      );
      return project;
    },
    async updateProject(id: string, input: UpdateProjectInput) {
      const existing = await service.getProject(id);
      if (!existing) return null;
      const updated: ProjectRecord = {
        ...existing,
        displayName: input.displayName ?? existing.displayName,
        path: input.path ?? existing.path,
        canonicalPath: input.canonicalPath ?? existing.canonicalPath,
        allowedRootId:
          input.allowedRootId === undefined
            ? existing.allowedRootId
            : (input.allowedRootId ?? undefined),
        git: input.git ?? existing.git,
        updatedAt: new Date().toISOString(),
      };
      db.prepare(
        `UPDATE projects SET display_name = ?, path = ?, canonical_path = ?, allowed_root_id = ?, git_json = ?, updated_at = ? WHERE id = ?`,
      ).run(
        updated.displayName,
        updated.path,
        updated.canonicalPath,
        updated.allowedRootId ?? null,
        updated.git ? JSON.stringify(updated.git) : null,
        updated.updatedAt,
        id,
      );
      return updated;
    },
    async deleteProject(id: string) {
      return db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
    },
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
  const [projects, settings] = await Promise.all([legacy.listProjects(), legacy.getAllSettings()]);

  for (const project of projects) {
    await storage.createProject({
      ...project,
    });
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
