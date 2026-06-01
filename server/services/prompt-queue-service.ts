import type { QueueMode } from "../../src/lib/session-drafts.ts";
import type { SelectedModel } from "../../src/types/electron.d.ts";
import type { BackendEventBus } from "./event-bus.ts";
import type { SessionService } from "./session-service.ts";
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
  text: string;
  images?: string[];
  createdAt: number;
  model?: SelectedModel;
  agent?: string;
  variant?: string;
  mode: QueueMode;
  order: number;
}

export interface CreatePromptQueueInput {
  text: string;
  images?: string[];
  model?: SelectedModel;
  agent?: string;
  variant?: string;
  mode: QueueMode;
}

export class PromptQueueService {
  private readonly storage: StorageService;
  private readonly sessions: SessionService;
  private readonly events?: BackendEventBus;

  constructor(storage: StorageService, sessions: SessionService, events?: BackendEventBus) {
    this.storage = storage;
    this.sessions = sessions;
    this.events = events;
  }

  async listSessionQueue(
    sessionIdOrAlias: string,
    scope: Pick<ListSessionsInput, "projectId" | "harnessId"> = {},
  ): Promise<PromptQueueEntry[]> {
    const session = await this.getSessionOrThrow(sessionIdOrAlias, scope);
    const entries = await this.storage.listPromptQueue(session.id);
    return entries.map((entry) => this.toPublicEntry(session, entry));
  }

  async listProjectQueues(
    scope: Pick<ListSessionsInput, "projectId" | "harnessId">,
  ): Promise<Record<string, PromptQueueEntry[]>> {
    const sessions = await this.listSessionsInScope(scope);
    const entries = await Promise.all(
      sessions.map(
        async (session) =>
          [
            this.toFrontendSessionId(session),
            (await this.storage.listPromptQueue(session.id)).map((entry) =>
              this.toPublicEntry(session, entry),
            ),
          ] as const,
      ),
    );
    return Object.fromEntries(entries);
  }

  async enqueue(
    sessionIdOrAlias: string,
    input: CreatePromptQueueInput,
    scope: Pick<ListSessionsInput, "projectId" | "harnessId"> = {},
  ): Promise<PromptQueueEntry[]> {
    const session = await this.getSessionOrThrow(sessionIdOrAlias, scope);
    const current = await this.storage.listPromptQueue(session.id);
    const created = await this.storage.createPromptQueueEntry({
      sessionId: session.id,
      text: input.text,
      images: input.images,
      model: input.model,
      agent: input.agent,
      variant: input.variant,
      mode: input.mode,
      order: current.length,
    });
    const next = await this.reindex(session.id);
    this.events?.emit(
      "queue.added",
      {
        sessionId: this.toFrontendSessionId(session),
        canonicalSessionId: session.id,
        entry: this.toPublicEntry(session, created),
        entries: next.map((entry) => this.toPublicEntry(session, entry)),
      },
      {
        projectId: session.projectId,
        sessionId: session.id,
        harnessId: session.harnessId,
      },
    );
    return next.map((entry) => this.toPublicEntry(session, entry));
  }

  async remove(
    sessionIdOrAlias: string,
    entryId: string,
    scope: Pick<ListSessionsInput, "projectId" | "harnessId"> = {},
  ): Promise<PromptQueueEntry[]> {
    const session = await this.getSessionOrThrow(sessionIdOrAlias, scope);
    await this.storage.deletePromptQueueEntry(entryId);
    const next = await this.reindex(session.id);
    this.events?.emit(
      "queue.removed",
      {
        sessionId: this.toFrontendSessionId(session),
        canonicalSessionId: session.id,
        entryId,
        entries: next.map((entry) => this.toPublicEntry(session, entry)),
      },
      {
        projectId: session.projectId,
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
    scope: Pick<ListSessionsInput, "projectId" | "harnessId"> = {},
  ): Promise<PromptQueueEntry[]> {
    const session = await this.getSessionOrThrow(sessionIdOrAlias, scope);
    await this.storage.updatePromptQueueEntry(entryId, input);
    const next = await this.reindex(session.id);
    this.events?.emit(
      "queue.updated",
      {
        sessionId: this.toFrontendSessionId(session),
        canonicalSessionId: session.id,
        entryId,
        entries: next.map((entry) => this.toPublicEntry(session, entry)),
      },
      {
        projectId: session.projectId,
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
    scope: Pick<ListSessionsInput, "projectId" | "harnessId"> = {},
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
        sessionId: this.toFrontendSessionId(session),
        canonicalSessionId: session.id,
        entryId,
        fromIndex,
        toIndex: clamped,
        entries: persisted.map((entry) => this.toPublicEntry(session, entry)),
      },
      {
        projectId: session.projectId,
        sessionId: session.id,
        harnessId: session.harnessId,
      },
    );
    return persisted.map((entry) => this.toPublicEntry(session, entry));
  }

  async clearSessionQueue(
    sessionIdOrAlias: string,
    scope: Pick<ListSessionsInput, "projectId" | "harnessId"> = {},
  ): Promise<boolean> {
    const session = await this.getSessionOrThrow(sessionIdOrAlias, scope);
    const removed = await this.storage.deletePromptQueueBySession(session.id);
    if (removed.length === 0) return false;
    this.events?.emit(
      "queue.cleared",
      {
        sessionId: this.toFrontendSessionId(session),
        canonicalSessionId: session.id,
      },
      {
        projectId: session.projectId,
        sessionId: session.id,
        harnessId: session.harnessId,
      },
    );
    return true;
  }

  private async getSessionOrThrow(
    sessionIdOrAlias: string,
    scope: Pick<ListSessionsInput, "projectId" | "harnessId">,
  ): Promise<SessionRecord> {
    const session = await this.sessions.getSession(sessionIdOrAlias, scope);
    if (!session) throw new Error("Session not found");
    return session;
  }

  private async listSessionsInScope(
    scope: Pick<ListSessionsInput, "projectId" | "harnessId">,
  ): Promise<SessionRecord[]> {
    const sessions: SessionRecord[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.sessions.listSessions({ ...scope, cursor, limit: 200 });
      sessions.push(...page.sessions);
      cursor = page.nextCursor;
    } while (cursor);
    return sessions;
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
      sessionId: this.toFrontendSessionId(session),
      canonicalSessionId: session.id,
    };
  }

  private toFrontendSessionId(session: SessionRecord) {
    return `${session.harnessId}:${session.rawId}`;
  }
}
