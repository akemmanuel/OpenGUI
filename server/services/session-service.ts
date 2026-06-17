import type { HarnessId } from "../../src/agents/index.ts";
import {
  composeFrontendSessionId,
  decodeCanonicalDirectorySessionId,
  harnessRawSessionKey,
  parseFrontendSessionId,
  resolveWireSessionIdentity,
  scopedRawSessionKey,
} from "../../src/lib/session-identity.ts";
import type { BackendEventBus } from "./event-bus.ts";
import type { StorageService } from "./storage-service.ts";
import type {
  CreateSessionInput,
  ListSessionsInput,
  ListSessionsResult,
  SessionRecord,
  UpdateSessionInput,
} from "./session-types.ts";

interface SessionMappingRecord {
  canonicalSessionId: string;
  directory: string;
  harnessId: HarnessId;
  rawId: string;
  createdAt: string;
  updatedAt: string;
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
      // Sessions and Session transcripts are Harness-owned. This in-memory index is
      // rebuilt from Harness results during Project hydration and never restored
      // from backend persistence.
      this.initialized = true;
      this.initPromise = null;
    })();
    await this.initPromise;
  }

  /**
   * In-memory index pagination only — not a product session list (ADR 0004/0006).
   * Sidebar and APIs use `listDirectorySessionsFromHarness`.
   */
  async listSessions(input: ListSessionsInput = {}): Promise<ListSessionsResult> {
    await this.ensureInitialized();
    const limit =
      typeof input.limit === "number" && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(200, Math.floor(input.limit)))
        : 200;
    const offset = decodeCursor(input.cursor);
    const filtered = [...this.sessions.values()]
      .filter((session) => {
        if (input.directory && session.directory !== input.directory) return false;
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
    input: Pick<ListSessionsInput, "directory" | "harnessId"> = {},
  ): Promise<SessionRecord | null> {
    await this.ensureInitialized();
    const canonicalId = this.resolveSessionId(idOrAlias, input);
    return canonicalId ? (this.sessions.get(canonicalId) ?? null) : null;
  }

  async getSessionByRawId(input: {
    directory: string;
    harnessId: HarnessId;
    rawId: string;
  }): Promise<SessionRecord | null> {
    await this.ensureInitialized();
    const canonicalId = this.rawToCanonical.get(scopedRawSessionKey(input));
    return canonicalId ? (this.sessions.get(canonicalId) ?? null) : null;
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    await this.ensureInitialized();
    const now = new Date().toISOString();
    const session: SessionRecord = {
      ...input,
      id: input.id ?? composeFrontendSessionId(input.harnessId, input.rawId),
      title: input.title ?? "Untitled",
      status: input.status ?? "unknown",
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? input.createdAt ?? now,
    };

    await this.persistStoredSession(session);
    this.events?.emit(
      "session.created",
      { sessionId: session.id, session },
      {
        directory: session.directory,
        sessionId: session.id,
        harnessId: session.harnessId,
      },
    );
    return session;
  }

  async ensureSession(input: CreateSessionInput): Promise<SessionRecord> {
    await this.ensureInitialized();
    const existing = await this.getSessionByRawId({
      directory: input.directory,
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

    const updated = {
      ...existing,
      title: nextTitle,
      status: nextStatus,
      metadata: nextMetadata,
      createdAt: nextCreatedAt,
      updatedAt: nextUpdatedAt,
    };
    await this.persistStoredSession(updated);
    const nextSession = this.sessions.get(existing.id) ?? updated;
    this.events?.emit(
      "session.updated",
      { sessionId: nextSession.id, session: nextSession },
      {
        directory: nextSession.directory,
        sessionId: nextSession.id,
        harnessId: nextSession.harnessId,
      },
    );
    return nextSession;
  }

  async updateSession(
    idOrAlias: string,
    input: UpdateSessionInput,
    scope: Pick<ListSessionsInput, "directory" | "harnessId"> = {},
  ): Promise<SessionRecord | null> {
    await this.ensureInitialized();
    const existing = await this.getSession(idOrAlias, scope);
    if (!existing) return null;

    const updated: SessionRecord = { ...existing, ...input, updatedAt: new Date().toISOString() };
    await this.persistStoredSession(updated);
    this.events?.emit(
      "session.updated",
      { sessionId: updated.id, session: updated },
      {
        directory: updated.directory,
        sessionId: updated.id,
        harnessId: updated.harnessId,
      },
    );
    return updated;
  }

  async deleteSession(
    idOrAlias: string,
    scope: Pick<ListSessionsInput, "directory" | "harnessId"> = {},
  ): Promise<boolean> {
    await this.ensureInitialized();
    const existing = await this.getSession(idOrAlias, scope);
    if (!existing) return false;
    await this.storage.deletePromptQueueBySession(existing.id);
    await this.removeStoredSession(existing);
    this.events?.emit(
      "session.deleted",
      { sessionId: existing.id, session: existing },
      {
        directory: existing.directory,
        sessionId: existing.id,
        harnessId: existing.harnessId,
      },
    );
    return true;
  }

  async deleteSessionsByDirectory(directory: string): Promise<SessionRecord[]> {
    await this.ensureInitialized();
    const sessions = [...this.sessions.values()].filter(
      (session) => session.directory === directory,
    );
    for (const session of sessions) {
      await this.deleteSession(session.id);
    }
    return sessions;
  }

  resolveSessionId(
    idOrAlias: string,
    scope: Pick<ListSessionsInput, "directory" | "harnessId"> = {},
  ): string | null {
    if (this.sessions.has(idOrAlias)) return idOrAlias;

    const wire = resolveWireSessionIdentity(idOrAlias, scope.harnessId);
    if (wire && this.sessions.has(wire.wireId)) return wire.wireId;

    const legacy = decodeCanonicalDirectorySessionId(idOrAlias);
    if (legacy) {
      const legacyWire = composeFrontendSessionId(legacy.harnessId, legacy.rawId);
      if (this.sessions.has(legacyWire)) return legacyWire;
    }

    const parsed = parseFrontendSessionId(idOrAlias);
    if (parsed) {
      return this.resolveByHarnessRawId(parsed.harnessId, parsed.rawId, scope);
    }

    if (scope.harnessId) {
      const resolved = this.resolveByHarnessRawId(scope.harnessId, idOrAlias, scope);
      if (resolved) return resolved;
    }

    const matches = [...this.sessions.values()].filter((session) => {
      if (session.rawId !== idOrAlias) return false;
      if (scope.directory && session.directory !== scope.directory) return false;
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
    scope: Pick<ListSessionsInput, "directory" | "harnessId">,
  ): string | null {
    const matches = [
      ...(this.harnessRawToCanonical.get(harnessRawSessionKey(harnessId, rawId)) ?? []),
    ]
      .map((id) => this.sessions.get(id))
      .filter((session): session is SessionRecord => Boolean(session))
      .filter((session) => {
        if (scope.directory && session.directory !== scope.directory) return false;
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
      directory: session.directory,
      harnessId: session.harnessId,
      rawId: session.rawId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });
  }

  private async upsertMapping(mapping: SessionMappingRecord) {
    this.storeMapping(mapping);
  }

  private storeMapping(mapping: SessionMappingRecord) {
    this.rawToCanonical.set(
      scopedRawSessionKey({
        directory: mapping.directory,
        harnessId: mapping.harnessId,
        rawId: mapping.rawId,
      }),
      mapping.canonicalSessionId,
    );
    const harnessRawKey = harnessRawSessionKey(mapping.harnessId, mapping.rawId);
    const existing = this.harnessRawToCanonical.get(harnessRawKey) ?? new Set<string>();
    existing.add(mapping.canonicalSessionId);
    this.harnessRawToCanonical.set(harnessRawKey, existing);
  }

  private async removeStoredSession(session: SessionRecord) {
    this.sessions.delete(session.id);
    const rawKey = scopedRawSessionKey({
      directory: session.directory,
      harnessId: session.harnessId,
      rawId: session.rawId,
    });
    this.rawToCanonical.delete(rawKey);
    const harnessRawKey = harnessRawSessionKey(session.harnessId, session.rawId);
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
