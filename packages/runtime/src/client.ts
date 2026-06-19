/**
 * Browser-safe @opengui/runtime surface (no harness bridges / Node subprocess SDK).
 * Use `@opengui/runtime` from server, Electron main, and tests that need full runtime.
 */

export type {
  LiveSessionEvent,
  LiveSessionEventHandler,
  LiveSessionEventType,
  LiveSessionScope,
} from "./live-session-events/live-session-event.ts";

export {
  LiveSessionProjection,
  type LiveSessionProjectedMessage,
  type LiveSessionProjectedPart,
} from "./live-session-events/live-session-projection.ts";

export type {
  ProjectedTranscriptEvent,
  ProjectedTranscriptSnapshot,
  ProjectedMessagePage,
  TranscriptMessageEntry,
  SessionTranscriptScope,
} from "./session-transcripts.ts";
