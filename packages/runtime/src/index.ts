/**
 * @opengui/runtime — in-process Harness execution.
 * See docs/plans/runtime-backend-sdk-split.md and ADR 0005.
 */

export {
  MANAGED_HARNESS_IDS,
  getHarnessIdFromBridgeChannel,
  isManagedHarnessId,
  normalizeBridgeEvent,
  registerHarnessAdapters,
  type HarnessControl,
  type HarnessIpcMain,
  type ManagedHarnessId,
  type RegisterHarnessAdaptersInput,
} from "./harness-runtime.ts";

export { createRuntimeHost, type CreateRuntimeHostInput, type RuntimeHost } from "./host.ts";

export type { DirectoryScopeRef } from "./directory-scope-types.ts";

export {
  HarnessService,
  createHarnessService,
  type HarnessScope,
  type HarnessTarget,
  type DirectoryConnectionConfig,
  type RuntimeSessionRef,
  type HarnessLifecycleEvents,
} from "./harness-service.ts";

export {
  createOpenGUI,
  OpenGuiSdkError,
  type CreateOpenGUIOptions,
  type HarnessHandle,
  type HarnessSessionsApi,
  type OpenGUI,
} from "./open-gui.ts";

export { type DirectoryHandle } from "./directory-handle.ts";

export {
  sessionIdFromCreateResult,
  type SessionHandle,
  type SessionSummary,
  type SendOptions,
  type MessagesOptions,
  type WaitUntilIdleOptions,
} from "./session-handle.ts";

export {
  filterStreamEventsForSession,
  liveSessionEventToAgentStreamEvents,
  streamEventMatchesSession,
  type AgentStreamEvent,
  type AgentStreamHandler,
} from "./agent-stream.ts";

export type {
  LiveSessionEvent,
  LiveSessionEventHandler,
  LiveSessionEventType,
  LiveSessionScope,
} from "./live-session-events/live-session-event.ts";
export { LiveSessionEventNormalizer } from "./live-session-events/live-session-normalizer.ts";
export { LiveSessionEventBus } from "./live-session-events/live-session-event-bus.ts";
export { harnessEventsToLiveSessionEvents } from "./live-session-events/harness-events-to-live.ts";
export {
  LiveSessionProjection,
  type LiveSessionProjectedMessage,
  type LiveSessionProjectedPart,
} from "./live-session-events/live-session-projection.ts";

export {
  InProcessIpcMain,
  InProcessIpcSender,
  type IpcEvent,
  type IpcSender,
} from "./in-process-ipc.ts";

export {
  isWithinAllowedRoot,
  normalizeAllowedRoots,
  resolveSafeDirectory,
} from "./directory-safety.ts";

export { directoryRef } from "./directory-ref.ts";

/** @deprecated Adapter diagnostics input — not the public SDK live contract (use `LiveSessionEvent`). */
export type { HarnessEvent } from "../../../src/agents/backend.ts";
export type { HarnessId } from "../../../src/agents/index.ts";
export type {
  DirectoryRegisterResult,
  HarnessResourceBundle,
} from "../../../src/protocol/client.ts";
export type { HarnessInventory } from "../../../src/types/electron.d.ts";

export {
  diagnoseFromInventories,
  type HarnessDiagnoseEntry,
  type OpenGUIDiagnoseResult,
} from "./diagnose.ts";

export { runAgent, type RunAgentOptions, type RunAgentResult } from "./run-agent.ts";

export {
  createSessionTranscriptProjection,
  type SessionTranscriptProjection,
} from "./session-transcript-projection.ts";

export {
  createLiveSessionTranscriptProjection,
  type LiveSessionTranscriptProjection,
} from "./live-session-transcript-projection.ts";

export {
  createSessionTranscripts,
  isTranscriptProjectionInput,
  projectedEntryToHarnessEvents,
  transcriptSessionId,
  type MessagePageResult,
  type ProjectedMessagePage,
  type ProjectedTranscriptEvent,
  type ProjectedTranscriptSnapshot,
  type SessionTranscriptScope,
  type SessionTranscripts,
  type TranscriptMessageEntry,
} from "./session-transcripts.ts";

export const RUNTIME_PACKAGE_ID = "@opengui/runtime" as const;
