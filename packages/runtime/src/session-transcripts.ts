import type { HarnessEvent } from "../../../src/agents/backend.ts";
import type { Message, Part } from "../../../src/protocol/harness-types.ts";
import {
  createSessionTranscriptProjection,
  type MessagePageResult,
  type SessionTranscriptScope,
  type TranscriptMessageEntry,
} from "./session-transcript-projection.ts";

export type { MessagePageResult, SessionTranscriptScope, TranscriptMessageEntry };

export interface ProjectedMessagePage extends MessagePageResult {
  revision: number;
}

export interface ProjectedTranscriptSnapshot {
  scope: SessionTranscriptScope;
  revision: number;
  page: ProjectedMessagePage;
}

export type ProjectedTranscriptEvent =
  | {
      type: "transcript.snapshot";
      scope: SessionTranscriptScope;
      revision: number;
      page: ProjectedMessagePage;
    }
  | {
      type: "transcript.message.removed";
      scope: SessionTranscriptScope;
      revision: number;
      messageID: string;
    };

export interface SessionTranscripts {
  ingest(input: { scope: SessionTranscriptScope; event: HarnessEvent }): ProjectedTranscriptEvent[];
  isHydrated(scope: SessionTranscriptScope): boolean;
  readPage(input: {
    scope: SessionTranscriptScope;
    options?: { limit?: number; before?: string | null };
    fetchHarnessPage: () => Promise<unknown>;
  }): Promise<ProjectedMessagePage>;
  snapshot(scope: SessionTranscriptScope): ProjectedTranscriptSnapshot | null;
  evict(scope: SessionTranscriptScope): void;
}

function scopeKey(scope: SessionTranscriptScope): string {
  return `${scope.directory}\u0000${scope.harnessId}\u0000${scope.sessionId}`;
}

function normalizeHarnessMessagePage(raw: unknown): MessagePageResult {
  if (!raw || typeof raw !== "object") return { messages: [], nextCursor: null };
  const record = raw as Record<string, unknown>;
  return {
    messages: Array.isArray(record.messages) ? (record.messages as TranscriptMessageEntry[]) : [],
    nextCursor: typeof record.nextCursor === "string" ? record.nextCursor : null,
  };
}

function isTranscriptMutation(event: HarnessEvent): boolean {
  switch (event.type) {
    case "message.updated":
    case "message.replaced":
    case "message.part.updated":
    case "message.part.delta":
    case "message.part.removed":
    case "message.removed":
    case "session.status":
      return true;
    default:
      return false;
  }
}

export function createSessionTranscripts(): SessionTranscripts {
  const projections = new Map<string, ReturnType<typeof createSessionTranscriptProjection>>();
  const pageCursors = new Map<string, string | null>();
  const hydratedScopes = new Set<string>();

  const getProjection = (scope: SessionTranscriptScope) => {
    const key = scopeKey(scope);
    let projection = projections.get(key);
    if (!projection) {
      projection = createSessionTranscriptProjection(scope);
      projections.set(key, projection);
    }
    return projection;
  };

  return {
    ingest({ scope, event }) {
      if (!isTranscriptMutation(event)) return [];
      const key = scopeKey(scope);
      const projection = getProjection(scope);
      const cursor = pageCursors.get(key) ?? null;
      const removedMessageID = event.type === "message.removed" ? event.messageID : null;

      const projectedInputs = projection.ingestHarnessEvent(event);
      if (projectedInputs.length === 0) return [];
      const revision = projection.getRevision();
      const messages = projection.getMessages();
      const canEmitWholeSnapshot = hydratedScopes.has(key) && messages.length > 0;

      if (event.type === "session.status") {
        if (event.status?.type !== "idle") return [];
        if (!canEmitWholeSnapshot) return [];
        const page: ProjectedMessagePage = {
          messages,
          nextCursor: cursor,
          revision,
        };
        return [{ type: "transcript.snapshot", scope, revision, page }];
      }

      if (removedMessageID) {
        return [
          { type: "transcript.message.removed", scope, revision, messageID: removedMessageID },
        ];
      }

      // Order-only changes are covered by LiveSessionEvent + run.finished final page reconcile.
      return [];
    },

    isHydrated(scope) {
      return hydratedScopes.has(scopeKey(scope));
    },

    async readPage({ scope, options, fetchHarnessPage }) {
      const projection = getProjection(scope);
      const page = normalizeHarnessMessagePage(await fetchHarnessPage());
      projection.hydrateFromHarnessPage(page, { before: options?.before ?? null });
      const key = scopeKey(scope);
      pageCursors.set(key, page.nextCursor);
      hydratedScopes.add(key);
      return {
        messages: projection.getMessages({ before: options?.before, limit: options?.limit }),
        nextCursor: page.nextCursor,
        revision: projection.getRevision(),
      };
    },

    snapshot(scope) {
      const projection = projections.get(scopeKey(scope));
      if (!projection) return null;
      const revision = projection.getRevision();
      return {
        scope,
        revision,
        page: {
          messages: projection.getMessages(),
          nextCursor: pageCursors.get(scopeKey(scope)) ?? null,
          revision,
        },
      };
    },

    evict(scope) {
      const key = scopeKey(scope);
      projections.delete(key);
      pageCursors.delete(key);
      hydratedScopes.delete(key);
    },
  };
}

export function transcriptSessionId(event: HarnessEvent): string | null {
  switch (event.type) {
    case "message.updated":
      return event.message.sessionID;
    case "message.replaced":
      return event.sessionID;
    case "message.part.updated":
      return event.part.sessionID;
    case "message.part.delta":
    case "message.part.removed":
    case "message.removed":
    case "session.status":
      return event.sessionID;
    default:
      return null;
  }
}

export function isTranscriptProjectionInput(event: HarnessEvent): boolean {
  return transcriptSessionId(event) !== null;
}

export function projectedEntryToHarnessEvents(entry: TranscriptMessageEntry): HarnessEvent[] {
  return [
    { type: "message.updated", message: entry.info as Message },
    ...entry.parts.map((part) => ({ type: "message.part.updated", part: part as Part }) as const),
  ];
}
