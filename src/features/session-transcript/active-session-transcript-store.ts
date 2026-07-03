import type { MessageEntry } from "@/hooks/agent-state-types";
import { ActiveSessionLiveProjection } from "@/features/session-transcript/live-message-projection";
import { mergeTranscriptPageWithLive } from "@/features/session-transcript/transcript-merge";
import type {
  ActiveTranscriptInput,
  ActiveTranscriptScope,
  ActiveTranscriptSnapshot,
} from "@/features/session-transcript/transcript-input";
import { scopeFromLiveEvent, scopesEqual } from "@/features/session-transcript/transcript-input";

export type ActiveTranscriptListener = (snapshot: ActiveTranscriptSnapshot) => void;

function emptySnapshot(): ActiveTranscriptSnapshot {
  return {
    scope: null,
    phase: "empty",
    messages: [],
    hasOlder: false,
    olderCursor: null,
    loadingOlder: false,
    olderError: null,
    error: null,
    revision: 0,
    running: false,
  };
}

function upsertMessage(messages: MessageEntry[], entry: MessageEntry): MessageEntry[] {
  const index = messages.findIndex((m) => m.info.id === entry.info.id);
  if (index < 0) return [...messages, entry];
  const next = [...messages];
  next[index] = entry;
  return next;
}

function removeMessage(messages: MessageEntry[], messageId: string): MessageEntry[] {
  return messages.filter((m) => m.info.id !== messageId);
}

function rebaseMessageId(
  messages: MessageEntry[],
  oldMessageId: string,
  newMessageId: string,
): MessageEntry[] {
  if (oldMessageId === newMessageId) return messages;
  const index = messages.findIndex((m) => m.info.id === oldMessageId);
  if (index < 0) return messages;
  const entry = messages[index]!;
  const rebased: MessageEntry = {
    info: { ...entry.info, id: newMessageId },
    parts: entry.parts.map((part) => ({
      ...part,
      messageID: newMessageId,
    })),
  };
  const next = [...messages];
  next[index] = rebased;
  return next;
}

function promptHistoryFromMessages(messages: MessageEntry[]): { key: string; history: string[] } {
  const parts: string[] = [];
  const history: string[] = [];
  for (const message of messages) {
    if (message.info.role !== "user") continue;
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => ("text" in part ? part.text : ""))
      .join("");
    if (!text) continue;
    parts.push(`${message.info.id}\u0000${text}`);
    history.unshift(text);
  }
  return { key: parts.join("\u0001"), history };
}

function messageOrderKey(messages: MessageEntry[]): string {
  return messages.map((message) => `${message.info.id}\u0000${message.info.role}`).join("\u0001");
}

function contextKey(messages: MessageEntry[]): string {
  return messages
    .map((message) => {
      if (message.info.role !== "assistant") return `${message.info.id}\u0000${message.info.role}`;
      const info = message.info as Record<string, unknown>;
      const stepTokenParts = message.parts
        .filter((part) => part.type === "step-finish" && "tokens" in part)
        .map((part) => JSON.stringify((part as Record<string, unknown>).tokens ?? null));
      return [
        message.info.id,
        message.info.role,
        info.providerID,
        info.modelID,
        info.cost,
        JSON.stringify(info.tokens ?? null),
        stepTokenParts.join("|"),
      ].join("\u0000");
    })
    .join("\u0001");
}

function compactionTailKey(messages: MessageEntry[]): string {
  return messages
    .slice(-2)
    .map((message) => {
      const summary = "summary" in message.info ? JSON.stringify(message.info.summary ?? null) : "";
      return [message.info.id, message.info.role, summary].join("\u0000");
    })
    .join("\u0001");
}

export type FrameSchedulerHandle = number | (() => void);

export type FrameScheduler = {
  schedule: (cb: () => void) => FrameSchedulerHandle;
  cancel: (handle: FrameSchedulerHandle) => void;
};

export function createDefaultFrameScheduler(): FrameScheduler {
  return {
    schedule: (cb) => {
      if (typeof requestAnimationFrame === "function") {
        return requestAnimationFrame(cb);
      }
      queueMicrotask(cb);
      return cb;
    },
    cancel: (handle) => {
      if (typeof handle === "number" && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(handle);
      }
    },
  };
}

export class ActiveSessionTranscriptStore {
  private snapshot: ActiveTranscriptSnapshot = emptySnapshot();
  private historySnapshot: Pick<ActiveTranscriptSnapshot, "hasOlder" | "loadingOlder" | "phase"> = {
    hasOlder: false,
    loadingOlder: false,
    phase: "empty",
  };
  private promptHistoryKey = "";
  private promptHistory: readonly string[] = [];
  private messageOrderKey = "";
  private messageOrderMessages: readonly MessageEntry[] = [];
  private contextKey = "";
  private contextMessages: readonly MessageEntry[] = [];
  private compactionTailKey = "";
  private compactionTailMessages: readonly MessageEntry[] = [];
  private listeners = new Set<ActiveTranscriptListener>();
  private liveProjection = new ActiveSessionLiveProjection();
  private frameScheduler: FrameScheduler;
  private pendingLive = false;
  private frameCallback: (() => void) | null = null;
  private frameHandle: FrameSchedulerHandle | null = null;

  constructor(options?: { frameScheduler?: FrameScheduler }) {
    this.frameScheduler = options?.frameScheduler ?? createDefaultFrameScheduler();
  }

  getSnapshot(): ActiveTranscriptSnapshot {
    return this.snapshot;
  }

  getHistorySnapshot(): Pick<ActiveTranscriptSnapshot, "hasOlder" | "loadingOlder" | "phase"> {
    const next = {
      hasOlder: this.snapshot.hasOlder,
      loadingOlder: this.snapshot.loadingOlder,
      phase: this.snapshot.phase,
    };
    if (
      next.hasOlder === this.historySnapshot.hasOlder &&
      next.loadingOlder === this.historySnapshot.loadingOlder &&
      next.phase === this.historySnapshot.phase
    ) {
      return this.historySnapshot;
    }
    this.historySnapshot = next;
    return this.historySnapshot;
  }

  getPromptHistory(): readonly string[] {
    const { key, history } = promptHistoryFromMessages(this.snapshot.messages);
    if (key === this.promptHistoryKey) return this.promptHistory;
    this.promptHistoryKey = key;
    this.promptHistory = history;
    return this.promptHistory;
  }

  getMessageOrderMessages(): readonly MessageEntry[] {
    const key = messageOrderKey(this.snapshot.messages);
    if (key === this.messageOrderKey) return this.messageOrderMessages;
    this.messageOrderKey = key;
    this.messageOrderMessages = this.snapshot.messages;
    return this.messageOrderMessages;
  }

  getContextMessages(): readonly MessageEntry[] {
    const key = contextKey(this.snapshot.messages);
    if (key === this.contextKey) return this.contextMessages;
    this.contextKey = key;
    this.contextMessages = this.snapshot.messages;
    return this.contextMessages;
  }

  getCompactionTailMessages(): readonly MessageEntry[] {
    const key = compactionTailKey(this.snapshot.messages);
    if (key === this.compactionTailKey) return this.compactionTailMessages;
    this.compactionTailKey = key;
    this.compactionTailMessages = this.snapshot.messages.slice(-2);
    return this.compactionTailMessages;
  }

  subscribe(listener: ActiveTranscriptListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispatch(input: ActiveTranscriptInput): void {
    switch (input.type) {
      case "reset":
        this.clearPendingLiveCommit();
        this.liveProjection.resetScope(null);
        this.commit(emptySnapshot());
        return;
      case "select":
        this.clearPendingLiveCommit();
        this.liveProjection.resetScope(input.scope);
        if (!input.scope) {
          this.commit(emptySnapshot());
          return;
        }
        if (scopesEqual(this.snapshot.scope, input.scope)) {
          return;
        }
        this.commit({
          ...emptySnapshot(),
          scope: input.scope,
          phase: "loading",
          revision: this.snapshot.revision + 1,
        });
        return;
      case "page.failed":
        if (!scopesEqual(this.snapshot.scope, input.scope)) return;
        if (input.phase === "older") {
          this.commit({
            ...this.snapshot,
            loadingOlder: false,
            olderError: input.error,
            revision: this.snapshot.revision + 1,
          });
          return;
        }
        this.commit({
          ...this.snapshot,
          phase: "error",
          error: input.error,
          loadingOlder: false,
          revision: this.snapshot.revision + 1,
        });
        return;
      case "page.loaded":
        this.applyPageLoaded(input);
        return;
      case "snapshot.loaded":
        this.applyIdleSnapshot(input);
        return;
      case "live":
        this.applyLive(input.event);
        return;
      case "message.removed":
        if (!scopesEqual(this.snapshot.scope, input.scope)) return;
        this.commit({
          ...this.snapshot,
          messages: removeMessage(this.snapshot.messages, input.messageId),
          revision: this.snapshot.revision + 1,
        });
        return;
      default:
        return;
    }
  }

  ingestLive(event: import("@opengui/runtime/client").LiveSessionEvent): void {
    this.dispatch({ type: "live", event });
  }

  select(scope: ActiveTranscriptScope | null): void {
    this.dispatch({ type: "select", scope });
  }

  private applyPageLoaded(input: Extract<ActiveTranscriptInput, { type: "page.loaded" }>): void {
    if (!scopesEqual(this.snapshot.scope, input.scope)) return;

    const merged = mergeTranscriptPageWithLive(this.snapshot.messages, input.messages, {
      running: this.snapshot.running,
      phase: input.phase,
    });

    const next: ActiveTranscriptSnapshot = {
      ...this.snapshot,
      phase: "ready",
      messages: merged,
      error: null,
      olderError: null,
      revision: this.snapshot.revision + 1,
      loadingOlder: input.phase === "older" ? false : this.snapshot.loadingOlder,
    };

    if (input.phase === "older") {
      next.hasOlder = input.hasMore;
      next.olderCursor = input.nextCursor;
    } else if (input.phase === "initial" || input.phase === "final") {
      next.hasOlder = input.hasMore;
      next.olderCursor = input.nextCursor;
    }

    this.commit(next);
  }

  private applyLive(event: Extract<ActiveTranscriptInput, { type: "live" }>["event"]): void {
    const scope = scopeFromLiveEvent(event);
    if (!scopesEqual(this.snapshot.scope, scope)) return;

    if (event.type === "run.started") {
      this.commit({ ...this.snapshot, running: true });
      return;
    }

    if (event.type === "run.finished") {
      this.commit({ ...this.snapshot, running: false });
      return;
    }

    if (event.type === "transcript.rebased" && event.replacement) {
      const { oldMessageId, newMessageId } = event.replacement;
      this.liveProjection.ingest(event);
      const hadOldMessage = this.snapshot.messages.some(
        (message) => message.info.id === oldMessageId,
      );
      if (hadOldMessage && oldMessageId && newMessageId) {
        this.commit({
          ...this.snapshot,
          messages: rebaseMessageId(this.snapshot.messages, oldMessageId, newMessageId),
          revision: this.snapshot.revision + 1,
        });
      }
      return;
    }

    const entry = this.liveProjection.ingest(event);
    if (!entry) return;

    const draftMessages = upsertMessage(this.snapshot.messages, entry);
    this.snapshot = {
      ...this.snapshot,
      messages: draftMessages,
    };
    this.scheduleLiveCommit();
  }

  private scheduleLiveCommit(): void {
    if (this.pendingLive) return;
    this.pendingLive = true;
    const commitRevision = this.snapshot.revision;
    this.frameCallback = () => {
      this.pendingLive = false;
      this.frameCallback = null;
      this.frameHandle = null;
      if (this.snapshot.revision !== commitRevision) {
        return;
      }
      this.commit({
        ...this.snapshot,
        phase: this.snapshot.phase === "loading" ? "ready" : this.snapshot.phase,
        revision: this.snapshot.revision + 1,
      });
    };
    this.frameHandle = this.frameScheduler.schedule(this.frameCallback);
  }

  private clearPendingLiveCommit(): void {
    if (this.frameHandle !== null) {
      this.frameScheduler.cancel(this.frameHandle);
      this.frameHandle = null;
    }
    this.frameCallback = null;
    this.pendingLive = false;
  }

  private applyIdleSnapshot(
    input: Extract<ActiveTranscriptInput, { type: "snapshot.loaded" }>,
  ): void {
    if (!scopesEqual(this.snapshot.scope, input.scope)) return;
    if (this.snapshot.running) return;
    this.commit({
      ...this.snapshot,
      phase: "ready",
      messages: input.messages,
      hasOlder: input.hasMore,
      olderCursor: input.nextCursor,
      error: null,
      olderError: null,
      running: false,
      revision: this.snapshot.revision + 1,
    });
  }

  beginLoadOlder(): boolean {
    if (
      !this.snapshot.scope ||
      this.snapshot.loadingOlder ||
      !this.snapshot.hasOlder ||
      !this.snapshot.olderCursor
    ) {
      return false;
    }
    this.commit({ ...this.snapshot, loadingOlder: true, olderError: null });
    return true;
  }

  private commit(next: ActiveTranscriptSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }
}
