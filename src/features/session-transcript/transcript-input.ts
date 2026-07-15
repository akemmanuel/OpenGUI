import type { MessageEntry } from "@/hooks/agent-state-types";
import { normalizeProjectPath } from "@/lib/utils";

export type ActiveTranscriptScope = {
  directory: string;
  sessionId: string;
};

export type ActiveTranscriptPagePhase = "initial" | "older" | "final";

export type ActiveTranscriptInput =
  | { type: "select"; scope: ActiveTranscriptScope | null }
  | {
      type: "page.loaded";
      scope: ActiveTranscriptScope;
      messages: MessageEntry[];
      hasMore: boolean;
      nextCursor: string | null;
      phase: ActiveTranscriptPagePhase;
    }
  | {
      type: "page.failed";
      scope: ActiveTranscriptScope;
      error: string;
      phase: ActiveTranscriptPagePhase;
    }
  | {
      type: "snapshot.loaded";
      scope: ActiveTranscriptScope;
      messages: MessageEntry[];
      hasMore: boolean;
      nextCursor: string | null;
    }
  | { type: "message.removed"; scope: ActiveTranscriptScope; messageId: string }
  | { type: "reset" };

export type ActiveTranscriptPhase = "empty" | "loading" | "ready" | "error";

export type ActiveTranscriptSnapshot = {
  scope: ActiveTranscriptScope | null;
  phase: ActiveTranscriptPhase;
  messages: MessageEntry[];
  hasOlder: boolean;
  olderCursor: string | null;
  loadingOlder: boolean;
  olderError: string | null;
  error: string | null;
  revision: number;
  running: boolean;
};

export function scopesEqual(
  a: ActiveTranscriptScope | null | undefined,
  b: ActiveTranscriptScope | null | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    normalizeProjectPath(a.directory) === normalizeProjectPath(b.directory) &&
    a.sessionId === b.sessionId
  );
}
