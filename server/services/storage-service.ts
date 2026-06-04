import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HarnessId } from "../../src/agents/index.ts";
import type { QueueMode } from "../../src/lib/session-drafts.ts";
import type { SelectedModel } from "../../src/types/electron.d.ts";
import type { CreateSessionInput, SessionRecord, UpdateSessionInput } from "./session-types.ts";

const PROJECTS_FILE = "projects.json";
const SETTINGS_FILE = "settings.json";
const SESSIONS_FILE = "sessions.json";
const SESSION_MAPPINGS_FILE = "session-mappings.json";
const PROMPT_QUEUE_FILE = "prompt-queue.json";
const SQLITE_FILE = "opengui.sqlite";

export interface ProjectRecord {
  id: string;
  displayName: string;
  path: string;
  canonicalPath: string;
  allowedRootId?: string;
  git?: {
    currentBranch?: string;
    remoteUrl?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface SessionMappingRecord {
  canonicalSessionId: string;
  projectId: string;
  harnessId: HarnessId;
  rawId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PromptQueueEntryRecord {
  id: string;
  sessionId: string;
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
  listSessions(): Promise<SessionRecord[]>;
  getSession(id: string): Promise<SessionRecord | null>;
  createSession(input: CreateSessionInput): Promise<SessionRecord>;
  updateSession(
    id: string,
    input: UpdateSessionInput & { createdAt?: string; updatedAt?: string },
  ): Promise<SessionRecord | null>;
  deleteSession(id: string): Promise<boolean>;
  deleteSessionsByProject(projectId: string): Promise<SessionRecord[]>;

  listSessionMappings(): Promise<SessionMappingRecord[]>;
  getSessionMapping(input: {
    projectId: string;
    harnessId: HarnessId;
    rawId: string;
  }): Promise<SessionMappingRecord | null>;
  upsertSessionMapping(input: SessionMappingRecord): Promise<SessionMappingRecord>;
  deleteSessionMapping(input: {
    projectId: string;
    harnessId: HarnessId;
    rawId: string;
  }): Promise<boolean>;
  deleteSessionMappingsByCanonicalSessionId(canonicalSessionId: string): Promise<boolean>;

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

function generateSessionId(): string {
  return createId("session");
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
  return [
    PROJECTS_FILE,
    SETTINGS_FILE,
    SESSIONS_FILE,
    SESSION_MAPPINGS_FILE,
    PROMPT_QUEUE_FILE,
  ].some((file) => existsSync(join(dataDir, file)));
}

export function createJsonStorageService(dataDir: string): StorageService {
  mkdirSync(dataDir, { recursive: true });

  const projectsPath = join(dataDir, PROJECTS_FILE);
  const settingsPath = join(dataDir, SETTINGS_FILE);
  const sessionsPath = join(dataDir, SESSIONS_FILE);
  const sessionMappingsPath = join(dataDir, SESSION_MAPPINGS_FILE);
  const promptQueuePath = join(dataDir, PROMPT_QUEUE_FILE);

  function loadProjects(): ProjectRecord[] {
    return readJson<ProjectRecord[]>(projectsPath, []);
  }

  function saveProjects(projects: ProjectRecord[]): void {
    writeJson(projectsPath, projects);
  }

  function loadSessions(): SessionRecord[] {
    return readJson<SessionRecord[]>(sessionsPath, []);
  }

  function saveSessions(sessions: SessionRecord[]): void {
    writeJson(sessionsPath, sessions);
  }

  function loadSessionMappings(): SessionMappingRecord[] {
    return readJson<SessionMappingRecord[]>(sessionMappingsPath, []);
  }

  function saveSessionMappings(mappings: SessionMappingRecord[]): void {
    writeJson(sessionMappingsPath, mappings);
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

    async listSessions() {
      return loadSessions();
    },

    async getSession(id: string) {
      return loadSessions().find((session) => session.id === id) ?? null;
    },

    async createSession(input: CreateSessionInput) {
      const sessions = loadSessions();
      const now = new Date().toISOString();
      const session: SessionRecord = {
        id: input.id ?? generateSessionId(),
        rawId: input.rawId,
        projectId: input.projectId,
        harnessId: input.harnessId,
        title: input.title ?? "New session",
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? input.createdAt ?? now,
        status: input.status ?? "unknown",
        metadata: input.metadata,
      };
      sessions.push(session);
      saveSessions(sessions);
      return session;
    },

    async updateSession(
      id: string,
      input: UpdateSessionInput & { createdAt?: string; updatedAt?: string },
    ) {
      const sessions = loadSessions();
      const index = sessions.findIndex((session) => session.id === id);
      if (index === -1) return null;
      const existing = sessions[index]!;
      const updated: SessionRecord = {
        ...existing,
        title: input.title ?? existing.title,
        status: input.status ?? existing.status,
        metadata: input.metadata ?? existing.metadata,
        createdAt: input.createdAt ?? existing.createdAt,
        updatedAt: input.updatedAt ?? new Date().toISOString(),
      };
      sessions[index] = updated;
      saveSessions(sessions);
      return updated;
    },

    async deleteSession(id: string) {
      const sessions = loadSessions();
      const index = sessions.findIndex((session) => session.id === id);
      if (index === -1) return false;
      sessions.splice(index, 1);
      saveSessions(sessions);
      return true;
    },

    async deleteSessionsByProject(projectId: string) {
      const sessions = loadSessions();
      const removed = sessions.filter((session) => session.projectId === projectId);
      if (removed.length === 0) return [];
      saveSessions(sessions.filter((session) => session.projectId !== projectId));
      return removed;
    },

    async listSessionMappings() {
      return loadSessionMappings();
    },

    async getSessionMapping(input) {
      return (
        loadSessionMappings().find(
          (mapping) =>
            mapping.projectId === input.projectId &&
            mapping.harnessId === input.harnessId &&
            mapping.rawId === input.rawId,
        ) ?? null
      );
    },

    async upsertSessionMapping(input: SessionMappingRecord) {
      const mappings = loadSessionMappings();
      const index = mappings.findIndex(
        (mapping) =>
          mapping.projectId === input.projectId &&
          mapping.harnessId === input.harnessId &&
          mapping.rawId === input.rawId,
      );
      if (index === -1) {
        mappings.push(input);
      } else {
        mappings[index] = input;
      }
      saveSessionMappings(mappings);
      return input;
    },

    async deleteSessionMapping(input) {
      const mappings = loadSessionMappings();
      const next = mappings.filter(
        (mapping) =>
          !(
            mapping.projectId === input.projectId &&
            mapping.harnessId === input.harnessId &&
            mapping.rawId === input.rawId
          ),
      );
      if (next.length === mappings.length) return false;
      saveSessionMappings(next);
      return true;
    },

    async deleteSessionMappingsByCanonicalSessionId(canonicalSessionId: string) {
      const mappings = loadSessionMappings();
      const next = mappings.filter((mapping) => mapping.canonicalSessionId !== canonicalSessionId);
      if (next.length === mappings.length) return false;
      saveSessionMappings(next);
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

export function createSqliteStorageService(dataDir: string): StorageService {
  return createJsonStorageService(dataDir);
}

async function migrateJsonStorageToSqlite(dataDir: string, storage: StorageService): Promise<void> {
  const legacy = createJsonStorageService(dataDir);
  const [projects, sessions, mappings, queue, settings] = await Promise.all([
    legacy.listProjects(),
    legacy.listSessions(),
    legacy.listSessionMappings(),
    legacy.listPromptQueue(),
    legacy.getAllSettings(),
  ]);

  const projectIdMap = new Map<string, string>();
  for (const project of projects) {
    const created = await storage.createProject({
      ...project,
    });
    await storage.updateProject(created.id, {
      displayName: project.displayName,
      path: project.path,
      canonicalPath: project.canonicalPath,
      allowedRootId: project.allowedRootId,
      git: project.git,
    });
    projectIdMap.set(project.id, created.id);
  }

  for (const session of sessions) {
    await storage.createSession({
      ...session,
      id: session.id,
      projectId: projectIdMap.get(session.projectId) ?? session.projectId,
    });
  }
  for (const mapping of mappings) {
    await storage.upsertSessionMapping({
      ...mapping,
      projectId: projectIdMap.get(mapping.projectId) ?? mapping.projectId,
    });
  }
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
  const storage = createSqliteStorageService(dataDir);
  if (!sqliteExists && hasLegacyJsonStorage(dataDir)) {
    await migrateJsonStorageToSqlite(dataDir, storage);
  }
  return storage;
}
