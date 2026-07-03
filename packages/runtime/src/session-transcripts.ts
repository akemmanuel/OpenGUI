import type { HarnessEvent } from "../../../src/agents/backend.ts";
import type { LiveSessionEvent } from "./live-session-events/live-session-event.ts";
import { createLiveSessionTranscriptProjection } from "./live-session-transcript-projection.ts";
import {
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
  ingest(input: {
    scope: SessionTranscriptScope;
    events: LiveSessionEvent[];
  }): ProjectedTranscriptEvent[];
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

function isLiveTranscriptMutation(events: LiveSessionEvent[]): boolean {
  for (const event of events) {
    switch (event.type) {
      case "message.started":
      case "message.finished":
      case "part.started":
      case "part.text.appended":
      case "part.text.replaced":
      case "part.state.changed":
      case "tool.started":
      case "tool.input.updated":
      case "tool.output.appended":
      case "tool.output.replaced":
      case "tool.finished":
      case "transcript.rebased":
      case "message.removed":
      case "run.finished":
        return true;
      default:
        break;
    }
  }
  return false;
}

export function createSessionTranscripts(): SessionTranscripts {
  const projections = new Map<string, ReturnType<typeof createLiveSessionTranscriptProjection>>();
  const pageCursors = new Map<string, string | null>();
  const hydratedScopes = new Set<string>();

  const getProjection = (scope: SessionTranscriptScope) => {
    const key = scopeKey(scope);
    let projection = projections.get(key);
    if (!projection) {
      projection = createLiveSessionTranscriptProjection(scope);
      projections.set(key, projection);
    }
    return projection;
  };

  return {
    ingest({ scope, events }) {
      if (events.length === 0 || !isLiveTranscriptMutation(events)) return [];
      const key = scopeKey(scope);
      const projection = getProjection(scope);
      const revisionBefore = projection.getRevision();
      const cursor = pageCursors.get(key) ?? null;

      projection.ingestLiveSessionEvents(events);

      const removed = events.find((e) => e.type === "message.removed");
      if (removed?.type === "message.removed" && removed.messageId) {
        const revision = projection.getRevision();
        return [
          {
            type: "transcript.message.removed",
            scope,
            revision,
            messageID: removed.messageId,
          },
        ];
      }

      if (projection.getRevision() === revisionBefore) return [];

      const revision = projection.getRevision();
      const messages = projection.getMessages();
      const canEmitWholeSnapshot = hydratedScopes.has(key) && messages.length > 0;

      const runFinished = events.some((e) => e.type === "run.finished" && e.reason === "idle");
      if (runFinished) {
        if (!canEmitWholeSnapshot) return [];
        const page: ProjectedMessagePage = {
          messages,
          nextCursor: cursor,
          revision,
        };
        return [{ type: "transcript.snapshot", scope, revision, page }];
      }

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
        messages: projection.getMessages(),
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
    { type: "message.updated", message: entry.info },
    ...entry.parts.map((part) => ({ type: "message.part.updated", part }) as const),
  ];
}
