import type { MessageEntry } from "@/hooks/agent-state-types";
import type {
  ActiveTranscriptInput,
  ActiveTranscriptScope,
  ActiveTranscriptSnapshot,
} from "@/features/session-transcript/transcript-input";
import { scopesEqual } from "@/features/session-transcript/transcript-input";

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

export class ActiveSessionTranscriptStore {
  private snapshot = emptySnapshot();
  private historySnapshot = this.createHistorySnapshot();
  private promptHistory = this.createPromptHistory();
  private compactionTailMessages: readonly MessageEntry[] = [];
  private readonly listeners = new Set<ActiveTranscriptListener>();

  private createHistorySnapshot() {
    const { hasOlder, loadingOlder, phase } = this.snapshot;
    return { hasOlder, loadingOlder, phase };
  }

  private createPromptHistory() {
    return this.snapshot.messages
      .filter((message) => message.info.role === "user")
      .map((message) =>
        message.parts
          .filter((part) => part.type === "text")
          .map((part) => ("text" in part ? part.text : ""))
          .join(""),
      )
      .filter(Boolean)
      .reverse();
  }

  getSnapshot() {
    return this.snapshot;
  }

  getHistorySnapshot() {
    return this.historySnapshot;
  }

  getPromptHistory() {
    return this.promptHistory;
  }

  getMessageOrderMessages(): readonly MessageEntry[] {
    return this.snapshot.messages;
  }

  getContextMessages(): readonly MessageEntry[] {
    return this.snapshot.messages;
  }

  getCompactionTailMessages(): readonly MessageEntry[] {
    return this.compactionTailMessages;
  }

  subscribe(listener: ActiveTranscriptListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private commit(snapshot: ActiveTranscriptSnapshot) {
    this.snapshot = snapshot;
    this.historySnapshot = this.createHistorySnapshot();
    this.promptHistory = this.createPromptHistory();
    this.compactionTailMessages = this.snapshot.messages.slice(-2);
    for (const listener of this.listeners) listener(snapshot);
  }

  dispatch(input: ActiveTranscriptInput) {
    if (input.type === "reset") {
      this.commit(emptySnapshot());
      return;
    }
    if (input.type === "select") {
      if (!input.scope) {
        this.commit(emptySnapshot());
      } else if (!scopesEqual(this.snapshot.scope, input.scope)) {
        this.commit({
          ...emptySnapshot(),
          scope: input.scope,
          phase: "loading",
          revision: this.snapshot.revision + 1,
        });
      }
      return;
    }
    if (!scopesEqual(this.snapshot.scope, input.scope)) return;
    if (input.type === "page.loaded" || input.type === "snapshot.loaded") {
      this.commit({
        ...this.snapshot,
        phase: "ready",
        messages: input.messages,
        hasOlder: input.hasMore,
        olderCursor: input.nextCursor,
        loadingOlder: false,
        olderError: null,
        error: null,
        revision: this.snapshot.revision + 1,
      });
      return;
    }
    if (input.type === "page.failed") {
      this.commit({
        ...this.snapshot,
        phase: "error",
        error: input.error,
        loadingOlder: false,
        revision: this.snapshot.revision + 1,
      });
      return;
    }
    if (input.type === "message.removed") {
      this.commit({
        ...this.snapshot,
        messages: this.snapshot.messages.filter((message) => message.info.id !== input.messageId),
        revision: this.snapshot.revision + 1,
      });
    }
  }

  select(scope: ActiveTranscriptScope | null) {
    this.dispatch({ type: "select", scope });
  }
}
