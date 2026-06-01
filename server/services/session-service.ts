import type { HarnessId } from "../../src/agents/index.ts";
import type { BackendEventBus } from "./event-bus.ts";
import type { SessionMappingRecord, StorageService } from "./storage-service.ts";
import type {
  CreateSessionInput,
  ListSessionsInput,
  ListSessionsResult,
  SessionRecord,
  UpdateSessionInput,
} from "./session-types.ts";

const KNOWN_HARNESS_IDS = ["opencode", "claude-code", "pi", "codex"] as const;

function createCanonicalSessionId(): string {
  return `session_${crypto.randomUUID()}`;
}

function createRawSessionKey(input: {
  projectId: string;
  harnessId: HarnessId;
  rawId: string;
}): string {
  return [input.projectId, input.harnessId, input.rawId].join("::");
}

function createHarnessRawKey(harnessId: HarnessId, rawId: string): string {
  return `${harnessId}::${rawId}`;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor?: string | null): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      offset?: unknown;
    };
    return typeof parsed.offset === "number" && parsed.offset >= 0 ? parsed.offset : 0;
  } catch {
    return 0;
  }
}

function parseHarnessPrefixedSessionId(
  value: string,
): { harnessId: HarnessId; rawId: string } | null {
  for (const harnessId of KNOWN_HARNESS_IDS) {
    const prefix = `${harnessId}:`;
    if (value.startsWith(prefix)) {
      return { harnessId, rawId: value.slice(prefix.length) };
    }
  }
  return null;
}

function sameMetadata(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export class SessionService {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly rawToCanonical = new Map<string, string>();
  private readonly harnessRawToCanonical = new Map<string, Set<string>>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  private readonly storage: StorageService;
  private readonly events?: BackendEventBus;

  constructor(storage: StorageService, events?: BackendEventBus) {
    this.storage = storage;
    this.events = events;
  }

  private async ensureInitialized() {
    if (this.initialized) return;
    if (this.initPromise) return await this.initPromise;
    this.initPromise = (async () => {
      const [sessions, mappings] = await Promise.all([
        this.storage.listSessions(),
        this.storage.listSessionMappings(),
      ]);
      for (const session of sessions) {
        this.sessions.set(session.id, session);
      }
      for (const mapping of mappings) {
        this.storeMapping(mapping, false);
      }
      for (const session of sessions) {
        const mappingKey = createRawSessionKey({
          projectId: session.projectId,
          harnessId: session.harnessId,
          rawId: session.rawId,
        });
        if (!this.rawToCanonical.has(mappingKey)) {
          this.storeMapping(
            {
              canonicalSessionId: session.id,
              projectId: session.projectId,
              harnessId: session.harnessId,
              rawId: session.rawId,
              createdAt: session.createdAt,
              updatedAt: session.updatedAt,
            },
            false,
          );
          await this.storage.upsertSessionMapping({
            canonicalSessionId: session.id,
            projectId: session.projectId,
            harnessId: session.harnessId,
            rawId: session.rawId,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
          });
        }
      }
      this.initialized = true;
      this.initPromise = null;
    })();
    await this.initPromise;
  }

  async listSessions(input: ListSessionsInput = {}): Promise<ListSessionsResult> {
    await this.ensureInitialized();
    const limit =
      typeof input.limit === "number" && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(200, Math.floor(input.limit)))
        : 200;
    const offset = decodeCursor(input.cursor);
    const filtered = [...this.sessions.values()]
      .filter((session) => {
        if (input.projectId && session.projectId !== input.projectId) return false;
        if (input.harnessId && session.harnessId !== input.harnessId) return false;
        return true;
      })
      .sort((left, right) => {
        const byUpdated = right.updatedAt.localeCompare(left.updatedAt);
        return byUpdated !== 0 ? byUpdated : right.id.localeCompare(left.id);
      });

    const sessions = filtered.slice(offset, offset + limit);
    const nextCursor = offset + limit < filtered.length ? encodeCursor(offset + limit) : null;
    return { sessions, nextCursor };
  }

  async getSession(
    idOrAlias: string,
    input: Pick<ListSessionsInput, "projectId" | "harnessId"> = {},
  ): Promise<SessionRecord | null> {
    await this.ensureInitialized();
    const canonicalId = this.resolveSessionId(idOrAlias, input);
    return canonicalId ? (this.sessions.get(canonicalId) ?? null) : null;
  }

  async getSessionByRawId(input: {
    projectId: string;
    harnessId: HarnessId;
    rawId: string;
  }): Promise<SessionRecord | null> {
    await this.ensureInitialized();
    const canonicalId = this.rawToCanonical.get(createRawSessionKey(input));
    return canonicalId ? (this.sessions.get(canonicalId) ?? null) : null;
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    await this.ensureInitialized();
    const now = new Date().toISOString();
    const session = await this.storage.createSession({
      ...input,
      id: input.id ?? createCanonicalSessionId(),
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? input.createdAt ?? now,
    });

    await this.persistStoredSession(session);
    this.events?.emit(
      "session.created",
      { sessionId: session.id, session },
      {
        projectId: session.projectId,
        sessionId: session.id,
        harnessId: session.harnessId,
      },
    );
    return session;
  }

  async ensureSession(input: CreateSessionInput): Promise<SessionRecord> {
    await this.ensureInitialized();
    const existing = await this.getSessionByRawId({
      projectId: input.projectId,
      harnessId: input.harnessId,
      rawId: input.rawId,
    });
    if (!existing) return await this.createSession(input);

    const nextTitle = input.title ?? existing.title;
    const nextStatus = input.status ?? existing.status;
    const nextMetadata = input.metadata ?? existing.metadata;
    const nextCreatedAt = input.createdAt ?? existing.createdAt;
    const nextUpdatedAt = input.updatedAt ?? existing.updatedAt;
    const changed =
      nextTitle !== existing.title ||
      nextStatus !== existing.status ||
      nextCreatedAt !== existing.createdAt ||
      nextUpdatedAt !== existing.updatedAt ||
      !sameMetadata(nextMetadata, existing.metadata);

    if (!changed) return existing;

    const updated = (await this.storage.updateSession(existing.id, {
      title: nextTitle,
      status: nextStatus,
      metadata: nextMetadata,
      createdAt: nextCreatedAt,
      updatedAt: nextUpdatedAt,
    })) ?? {
      ...existing,
      title: nextTitle,
      status: nextStatus,
      metadata: nextMetadata,
      createdAt: nextCreatedAt,
      updatedAt: nextUpdatedAt ?? new Date().toISOString(),
    };
    await this.persistStoredSession(updated);
    const nextSession = this.sessions.get(existing.id) ?? updated;
    this.events?.emit(
      "session.updated",
      { sessionId: nextSession.id, session: nextSession },
      {
        projectId: nextSession.projectId,
        sessionId: nextSession.id,
        harnessId: nextSession.harnessId,
      },
    );
    return nextSession;
  }

  async updateSession(
    idOrAlias: string,
    input: UpdateSessionInput,
    scope: Pick<ListSessionsInput, "projectId" | "harnessId"> = {},
  ): Promise<SessionRecord | null> {
    await this.ensureInitialized();
    const existing = await this.getSession(idOrAlias, scope);
    if (!existing) return null;

    const updated = await this.storage.updateSession(existing.id, input);
    if (!updated) return null;
    await this.persistStoredSession(updated);
    this.events?.emit(
      "session.updated",
      { sessionId: updated.id, session: updated },
      {
        projectId: updated.projectId,
        sessionId: updated.id,
        harnessId: updated.harnessId,
      },
    );
    return updated;
  }

  async deleteSession(
    idOrAlias: string,
    scope: Pick<ListSessionsInput, "projectId" | "harnessId"> = {},
  ): Promise<boolean> {
    await this.ensureInitialized();
    const existing = await this.getSession(idOrAlias, scope);
    if (!existing) return false;
    await this.storage.deleteSession(existing.id);
    await this.storage.deleteSessionMappingsByCanonicalSessionId(existing.id);
    await this.storage.deletePromptQueueBySession(existing.id);
    await this.removeStoredSession(existing);
    this.events?.emit(
      "session.deleted",
      { sessionId: existing.id, session: existing },
      {
        projectId: existing.projectId,
        sessionId: existing.id,
        harnessId: existing.harnessId,
      },
    );
    return true;
  }

  async deleteSessionsByProject(projectId: string): Promise<SessionRecord[]> {
    await this.ensureInitialized();
    const sessions = [...this.sessions.values()].filter(
      (session) => session.projectId === projectId,
    );
    for (const session of sessions) {
      await this.deleteSession(session.id);
    }
    return sessions;
  }

  async replaceScopeSessions(
    scope: { projectId: string; harnessId: HarnessId },
    nextSessions: CreateSessionInput[],
  ): Promise<SessionRecord[]> {
    await this.ensureInitialized();
    const seenRawIds = new Set(nextSessions.map((session) => session.rawId));
    const currentScopeSessions = [...this.sessions.values()].filter(
      (session) => session.projectId === scope.projectId && session.harnessId === scope.harnessId,
    );

    for (const session of currentScopeSessions) {
      if (!seenRawIds.has(session.rawId)) {
        await this.deleteSession(session.id);
      }
    }

    const records: SessionRecord[] = [];
    for (const session of nextSessions) {
      records.push(await this.ensureSession(session));
    }
    return records;
  }

  resolveSessionId(
    idOrAlias: string,
    scope: Pick<ListSessionsInput, "projectId" | "harnessId"> = {},
  ): string | null {
    if (this.sessions.has(idOrAlias)) return idOrAlias;

    const parsed = parseHarnessPrefixedSessionId(idOrAlias);
    if (parsed) {
      return this.resolveByHarnessRawId(parsed.harnessId, parsed.rawId, scope);
    }

    if (scope.harnessId) {
      const resolved = this.resolveByHarnessRawId(scope.harnessId, idOrAlias, scope);
      if (resolved) return resolved;
    }

    const matches = [...this.sessions.values()].filter((session) => {
      if (session.rawId !== idOrAlias) return false;
      if (scope.projectId && session.projectId !== scope.projectId) return false;
      if (scope.harnessId && session.harnessId !== scope.harnessId) return false;
      return true;
    });
    if (matches.length === 0) return null;
    matches.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return matches[0]?.id ?? null;
  }

  private resolveByHarnessRawId(
    harnessId: HarnessId,
    rawId: string,
    scope: Pick<ListSessionsInput, "projectId" | "harnessId">,
  ): string | null {
    const matches = [
      ...(this.harnessRawToCanonical.get(createHarnessRawKey(harnessId, rawId)) ?? []),
    ]
      .map((id) => this.sessions.get(id))
      .filter((session): session is SessionRecord => Boolean(session))
      .filter((session) => {
        if (scope.projectId && session.projectId !== scope.projectId) return false;
        if (scope.harnessId && session.harnessId !== scope.harnessId) return false;
        return true;
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return matches[0]?.id ?? null;
  }

  private async persistStoredSession(session: SessionRecord) {
    this.sessions.set(session.id, session);
    await this.upsertMapping({
      canonicalSessionId: session.id,
      projectId: session.projectId,
      harnessId: session.harnessId,
      rawId: session.rawId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });
  }

  private async upsertMapping(mapping: SessionMappingRecord) {
    this.storeMapping(mapping, false);
    await this.storage.upsertSessionMapping(mapping);
  }

  private storeMapping(mapping: SessionMappingRecord, persist = true) {
    this.rawToCanonical.set(
      createRawSessionKey({
        projectId: mapping.projectId,
        harnessId: mapping.harnessId,
        rawId: mapping.rawId,
      }),
      mapping.canonicalSessionId,
    );
    const harnessRawKey = createHarnessRawKey(mapping.harnessId, mapping.rawId);
    const existing = this.harnessRawToCanonical.get(harnessRawKey) ?? new Set<string>();
    existing.add(mapping.canonicalSessionId);
    this.harnessRawToCanonical.set(harnessRawKey, existing);
    if (persist) {
      void this.storage.upsertSessionMapping(mapping);
    }
  }

  private async removeStoredSession(session: SessionRecord) {
    this.sessions.delete(session.id);
    const rawKey = createRawSessionKey({
      projectId: session.projectId,
      harnessId: session.harnessId,
      rawId: session.rawId,
    });
    this.rawToCanonical.delete(rawKey);
    const harnessRawKey = createHarnessRawKey(session.harnessId, session.rawId);
    const set = this.harnessRawToCanonical.get(harnessRawKey);
    if (set) {
      set.delete(session.id);
      if (set.size === 0) this.harnessRawToCanonical.delete(harnessRawKey);
    }
  }
}

export type {
  CreateSessionInput,
  ListSessionsInput,
  ListSessionsResult,
  SessionRecord,
  UpdateSessionInput,
} from "./session-types.ts";
