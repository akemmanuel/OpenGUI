import type { QueueMode, SelectedModel } from "@opengui/protocol";
import type { BackendEventBus } from "./event-bus.ts";
import { sessionDirectoryHint } from "./directory-scope.ts";
import { resolveSessionRecordForMutation, wireSessionIdFromRecord } from "./session-resolve.ts";
import type { BackendServiceContext } from "./index.ts";
import type {
  PromptQueueEntryRecord,
  StorageService,
  UpdatePromptQueueEntryInput,
} from "./storage-service.ts";
import type { ListSessionsInput, SessionRecord } from "./session-types.ts";

export interface PromptQueueEntry {
  id: string;
  sessionId: string;
  canonicalSessionId: string;
  harnessId: SessionRecord["harnessId"];
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

export interface CreatePromptQueueInput {
  text: string;
  model?: SelectedModel;
  agent?: string;
  variant?: string;
  mode: QueueMode;
  insertAt?: "front" | "back";
}

export class PromptQueueService {
  private readonly storage: StorageService;
  private readonly events?: BackendEventBus;
  private readonly services: BackendServiceContext;
  private readonly resolveSafeDirectory: (path: string) => Promise<string>;

  constructor(
    services: BackendServiceContext,
    resolveSafeDirectory: (path: string) => Promise<string>,
  ) {
    this.storage = services.storage;
    this.services = services;
    this.resolveSafeDirectory = resolveSafeDirectory;
    this.events = services.events;
  }

  async listSessionQueue(
    sessionIdOrAlias: string,
    scope: Required<Pick<ListSessionsInput, "directory" | "harnessId">>,
  ): Promise<PromptQueueEntry[]> {
    const session = await this.getSessionOrThrow(sessionIdOrAlias, scope);
    const entries = await this.storage.listPromptQueue(session.id);
    return entries.map((entry) => this.toPublicEntry(session, entry));
  }

  async listProjectQueues(
    scope: Pick<ListSessionsInput, "directory" | "harnessId">,
  ): Promise<Record<string, PromptQueueEntry[]>> {
    const all = await this.storage.listPromptQueue();
    const filtered = all.filter((entry) => {
      if (scope.harnessId && entry.harnessId !== scope.harnessId) return false;
      if (scope.directory && entry.projectDirectory !== scope.directory) return false;
      return true;
    });
    const byWire = new Map<string, PromptQueueEntryRecord[]>();
    for (const entry of filtered) {
      const list = byWire.get(entry.sessionId) ?? [];
      list.push(entry);
      byWire.set(entry.sessionId, list);
    }
    const result: Record<string, PromptQueueEntry[]> = {};
    for (const [canonicalSessionId, records] of byWire) {
      const wireKey = records[0]
        ? `${records[0].harnessId}:${records[0].harnessSessionId}`
        : canonicalSessionId;
      const stub = sessionRecordFromQueueEntry(records[0]!);
      result[wireKey] = records.map((r) => this.toPublicEntry(stub, r));
    }
    return result;
  }

  async enqueue(
    sessionIdOrAlias: string,
    input: CreatePromptQueueInput,
    scope: Required<Pick<ListSessionsInput, "directory" | "harnessId">>,
  ): Promise<PromptQueueEntry[]> {
    const session = await this.getSessionOrThrow(sessionIdOrAlias, scope);
    const current = await this.storage.listPromptQueue(session.id);
    const created = await this.storage.createPromptQueueEntry({
      sessionId: session.id,
      harnessId: session.harnessId,
      projectDirectory: await this.getProjectDirectory(session),
      harnessSessionId: session.rawId,
      text: input.text,
      model: input.model,
      agent: input.agent,
      variant: input.variant,
      mode: input.mode,
      order: current.length,
    });
    let next = await this.reindex(session.id);
    if (input.insertAt === "front" && next.length > 1) {
      await this.storage.updatePromptQueueEntry(created.id, { order: -1 });
      next = await this.reindex(session.id);
    }
    const publicEntries = next.map((entry) => this.toPublicEntry(session, entry));
    const publicCreated = publicEntries.find((entry) => entry.id === created.id);
    this.events?.emit(
      "queue.added",
      {
        sessionId: wireSessionIdFromRecord(session),
        canonicalSessionId: session.id,
        entry: publicCreated ?? this.toPublicEntry(session, created),
        entries: publicEntries,
      },
      {
        directory: session.directory,
        sessionId: session.id,
        harnessId: session.harnessId,
      },
    );
    return publicEntries;
  }

  async remove(
    sessionIdOrAlias: string,
    entryId: string,
    scope: Required<Pick<ListSessionsInput, "directory" | "harnessId">>,
  ): Promise<PromptQueueEntry[]> {
    const session = await this.getSessionOrThrow(sessionIdOrAlias, scope);
    const current = await this.storage.listPromptQueue(session.id);
    if (!current.some((entry) => entry.id === entryId)) {
      return current.map((entry) => this.toPublicEntry(session, entry));
    }
    await this.storage.deletePromptQueueEntry(entryId);
    const next = await this.reindex(session.id);
    this.events?.emit(
      "queue.removed",
      {
        sessionId: wireSessionIdFromRecord(session),
        canonicalSessionId: session.id,
        entryId,
        entries: next.map((entry) => this.toPublicEntry(session, entry)),
      },
      {
        directory: session.directory,
        sessionId: session.id,
        harnessId: session.harnessId,
      },
    );
    return next.map((entry) => this.toPublicEntry(session, entry));
  }

  async update(
    sessionIdOrAlias: string,
    entryId: string,
    input: UpdatePromptQueueEntryInput,
    scope: Required<Pick<ListSessionsInput, "directory" | "harnessId">>,
  ): Promise<PromptQueueEntry[]> {
    const session = await this.getSessionOrThrow(sessionIdOrAlias, scope);
    const current = await this.storage.listPromptQueue(session.id);
    if (!current.some((entry) => entry.id === entryId)) {
      return current.map((entry) => this.toPublicEntry(session, entry));
    }
    await this.storage.updatePromptQueueEntry(entryId, input);
    const next = await this.reindex(session.id);
    this.events?.emit(
      "queue.updated",
      {
        sessionId: wireSessionIdFromRecord(session),
        canonicalSessionId: session.id,
        entryId,
        entries: next.map((entry) => this.toPublicEntry(session, entry)),
      },
      {
        directory: session.directory,
        sessionId: session.id,
        harnessId: session.harnessId,
      },
    );
    return next.map((entry) => this.toPublicEntry(session, entry));
  }

  async reorder(
    sessionIdOrAlias: string,
    entryId: string,
    toIndex: number,
    scope: Required<Pick<ListSessionsInput, "directory" | "harnessId">>,
  ): Promise<PromptQueueEntry[]> {
    const session = await this.getSessionOrThrow(sessionIdOrAlias, scope);
    const current = await this.storage.listPromptQueue(session.id);
    const fromIndex = current.findIndex((entry) => entry.id === entryId);
    if (fromIndex === -1 || current.length <= 1) {
      return current.map((entry) => this.toPublicEntry(session, entry));
    }
    const clamped = Math.max(0, Math.min(toIndex, current.length - 1));
    if (clamped === fromIndex) {
      return current.map((entry) => this.toPublicEntry(session, entry));
    }
    const next = [...current];
    const [moved] = next.splice(fromIndex, 1);
    if (!moved) {
      return current.map((entry) => this.toPublicEntry(session, entry));
    }
    next.splice(clamped, 0, moved);
    const persisted = await this.storage.replacePromptQueue(
      session.id,
      next.map((entry, index) => ({ ...entry, order: index })),
    );
    this.events?.emit(
      "queue.reordered",
      {
        sessionId: wireSessionIdFromRecord(session),
        canonicalSessionId: session.id,
        entryId,
        fromIndex,
        toIndex: clamped,
        entries: persisted.map((entry) => this.toPublicEntry(session, entry)),
      },
      {
        directory: session.directory,
        sessionId: session.id,
        harnessId: session.harnessId,
      },
    );
    return persisted.map((entry) => this.toPublicEntry(session, entry));
  }

  async clearSessionQueue(
    sessionIdOrAlias: string,
    scope: Required<Pick<ListSessionsInput, "directory" | "harnessId">>,
  ): Promise<boolean> {
    const session = await this.getSessionOrThrow(sessionIdOrAlias, scope);
    const removed = await this.storage.deletePromptQueueBySession(session.id);
    if (removed.length === 0) return false;
    this.events?.emit(
      "queue.cleared",
      {
        sessionId: wireSessionIdFromRecord(session),
        canonicalSessionId: session.id,
      },
      {
        directory: session.directory,
        sessionId: session.id,
        harnessId: session.harnessId,
      },
    );
    return true;
  }

  private async getSessionOrThrow(
    sessionIdOrAlias: string,
    scope: Required<Pick<ListSessionsInput, "directory" | "harnessId">>,
  ): Promise<SessionRecord> {
    return await resolveSessionRecordForMutation({
      services: this.services,
      sessionId: sessionIdOrAlias,
      scope,
      resolveSafeDirectory: this.resolveSafeDirectory,
    });
  }

  private async getProjectDirectory(session: SessionRecord): Promise<string> {
    const hint = sessionDirectoryHint(session);
    if (!hint) throw new Error("Session directory not found");
    return hint;
  }

  private async reindex(sessionId: string): Promise<PromptQueueEntryRecord[]> {
    const current = await this.storage.listPromptQueue(sessionId);
    return await this.storage.replacePromptQueue(
      sessionId,
      current.map((entry, index) => ({ ...entry, order: index })),
    );
  }

  private toPublicEntry(session: SessionRecord, entry: PromptQueueEntryRecord): PromptQueueEntry {
    return {
      ...entry,
      sessionId: wireSessionIdFromRecord(session),
      canonicalSessionId: session.id,
    };
  }
}

function sessionRecordFromQueueEntry(entry: PromptQueueEntryRecord): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: entry.sessionId,
    rawId: entry.harnessSessionId,
    directory: entry.projectDirectory,
    harnessId: entry.harnessId,
    title: "Queued session",
    status: "unknown",
    createdAt: now,
    updatedAt: now,
  };
}
