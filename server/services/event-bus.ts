import { EventEmitter } from "node:events";
import type { PromptQueueEntry } from "./prompt-queue-service.ts";
import type { ProjectRecord } from "./storage-service.ts";
import type { SessionRecord } from "./session-types.ts";

export interface BackendEventRefs {
  workspaceId?: string;
  projectId?: string;
  sessionId?: string;
  harnessId?: string;
}

export interface OpenGuiEventEnvelope<T = unknown> extends BackendEventRefs {
  id: string;
  type: string;
  createdAt: string;
  payload: T;
}

export interface BackendEventMap {
  "project.created": { projectId: string; project: ProjectRecord };
  "project.updated": { projectId: string; project: ProjectRecord };
  "project.deleted": { projectId: string; project: ProjectRecord };
  "session.created": { sessionId: string; session: SessionRecord };
  "session.updated": { sessionId: string; session: SessionRecord };
  "session.deleted": { sessionId: string; session: SessionRecord };
  "queue.added": {
    sessionId: string;
    canonicalSessionId: string;
    entry: PromptQueueEntry;
    entries: PromptQueueEntry[];
  };
  "queue.removed": {
    sessionId: string;
    canonicalSessionId: string;
    entryId: string;
    entries: PromptQueueEntry[];
  };
  "queue.updated": {
    sessionId: string;
    canonicalSessionId: string;
    entryId: string;
    entries: PromptQueueEntry[];
  };
  "queue.reordered": {
    sessionId: string;
    canonicalSessionId: string;
    entryId: string;
    fromIndex: number;
    toIndex: number;
    entries: PromptQueueEntry[];
  };
  "queue.cleared": { sessionId: string; canonicalSessionId: string };
  "harness.restarted": { harnessId: string };
  "runtime.error": { message: string; error?: string };
}

function createEventId() {
  return `evt_${crypto.randomUUID()}`;
}

export class BackendEventBus {
  private readonly emitter = new EventEmitter();
  private readonly history: OpenGuiEventEnvelope[] = [];
  private readonly historyLimit: number;

  constructor(historyLimit = 500) {
    this.historyLimit = historyLimit;
  }

  on<EventName extends keyof BackendEventMap>(
    eventName: EventName,
    listener: (payload: BackendEventMap[EventName]) => void,
  ): () => void {
    const wrapped = listener as (payload: unknown) => void;
    this.emitter.on(eventName, wrapped);
    return () => this.emitter.off(eventName, wrapped);
  }

  subscribe(listener: (event: OpenGuiEventEnvelope) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  listEventsAfter(cursor?: string | null): OpenGuiEventEnvelope[] {
    if (!cursor) return [...this.history];
    const index = this.history.findIndex((event) => event.id === cursor);
    return index === -1 ? [] : this.history.slice(index + 1);
  }

  emit<EventName extends keyof BackendEventMap>(
    eventName: EventName,
    payload: BackendEventMap[EventName],
    refs: BackendEventRefs = {},
  ): OpenGuiEventEnvelope<BackendEventMap[EventName]> {
    this.emitter.emit(eventName, payload);
    return this.publish(eventName, payload, refs);
  }

  publish<T>(type: string, payload: T, refs: BackendEventRefs = {}): OpenGuiEventEnvelope<T> {
    const event: OpenGuiEventEnvelope<T> = {
      id: createEventId(),
      type,
      createdAt: new Date().toISOString(),
      ...refs,
      payload,
    };
    this.history.push(event as OpenGuiEventEnvelope);
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
    this.emitter.emit("event", event);
    return event;
  }
}
