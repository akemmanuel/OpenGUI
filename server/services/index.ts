/**
 * Backend service barrel. Session list/message reads use harness-only paths
 * (`listDirectorySessionsFromHarness`, `resolveSessionRecordForRead`) per ADR 0006.
 * `SessionDispatchIndex` (`BackendServiceContext.sessions`) is queue/control cache only.
 */
import type { StorageService } from "./storage-service.ts";
import type { HarnessService } from "@opengui/runtime";
import type { BackendEventBus } from "./event-bus.ts";
import type { PromptQueueService } from "./prompt-queue-service.ts";
import type { SessionDispatchIndex } from "./session-dispatch-index.ts";

export {
  createJsonStorageService,
  createSqliteStorageService,
  createStorageService,
} from "./storage-service.ts";
export type {
  StorageService,
  PromptQueueEntryRecord,
  CreatePromptQueueEntryInput,
  UpdatePromptQueueEntryInput,
} from "./storage-service.ts";
export { HarnessService, createHarnessService } from "@opengui/runtime";
export type { HarnessControl, HarnessScope, DirectoryConnectionConfig } from "@opengui/runtime";
export { BackendEventBus } from "./event-bus.ts";
export type { BackendEventMap } from "./event-bus.ts";
export { SessionDispatchIndex } from "./session-dispatch-index.ts";
/** @deprecated Use `SessionDispatchIndex` — alias until external imports are gone. */
export { SessionDispatchIndex as SessionService } from "./session-dispatch-index.ts";
export type {
  SessionRecord,
  CreateSessionInput,
  UpdateSessionInput,
  ListSessionsInput,
  ListSessionsResult,
  ResolvedHarnessDirectory,
} from "./session-types.ts";
export { PromptQueueService } from "./prompt-queue-service.ts";
export type { PromptQueueEntry, CreatePromptQueueInput } from "./prompt-queue-service.ts";
export { getBackendCapabilities } from "./capabilities.ts";
export type { OpenGuiCapabilities } from "@opengui/protocol";
export { findFilesInDirectory } from "./file-search.ts";
export { runJobsWithConcurrency } from "./concurrency.ts";
export { buildHarnessScope, runtimeSessionBelongsToDirectory } from "./harness-scope.ts";
export {
  rejectHarnessQuestion,
  replyToHarnessQuestion,
  respondToHarnessPermission,
} from "./harness-interactions.ts";
export {
  readJsonBody,
  toOptionalNullableString,
  toOptionalSelectedModel,
  toOptionalString,
  toQuestionAnswers,
  toQueueMode,
} from "./http-input.ts";
export { listManagedHarnessDescriptors } from "./harness-descriptors.ts";
export {
  registerDirectoryWithHarnesses,
  releaseDirectoryFromHarnesses,
  getDirectoryHarnessStatus,
  loadDirectoryHarnessResources,
  directoryHarnessScope,
} from "./directory-harness-actions.ts";
export { resolveCanonicalDirectoryInput } from "./directory-input.ts";
export {
  registerSharedSessionControl,
  sendQueuedPromptNow,
  submitSessionPrompt,
} from "./shared-session-control.ts";
export {
  asSessionStatus,
  ensureSessionFromRuntime,
  toSessionRecordInputFromRuntime,
} from "./runtime-session-mapper.ts";
export {
  abortSessionThroughHarness,
  compactSessionThroughHarness,
  createDirectorySessionThroughHarness,
  createSessionThroughHarness,
  deleteSessionThroughHarness,
  forkSessionThroughHarness,
  listSessionMessagesThroughHarness,
  promptSessionThroughHarness,
  renameSessionThroughHarness,
  revertSessionThroughHarness,
  sendCommandThroughHarness,
  unrevertSessionThroughHarness,
} from "./session-lifecycle-actions.ts";
export {
  listSessionsForRequest,
  querySessionsForResolvedProjects,
  querySessionsFromFrontendProjects,
} from "./session-query.ts";
export {
  enqueueSessionPrompt,
  listDirectorySessionQueues,
  listSessionQueue,
  removeSessionPrompt,
  reorderSessionPrompt,
  updateSessionPrompt,
} from "./session-queue-actions.ts";
export { getSessionRecordOrThrow, updateSessionRecord } from "./session-record-actions.ts";
export {
  harnessScopeForDirectory,
  queueScopeForSession,
  resolveSessionCanonicalDirectory,
  resolveSessionDirectoryScope,
  resolveSessionDirectoryScopeRecord,
  sessionDirectoryHint,
} from "./directory-scope.ts";
export { listDirectorySessionsFromHarness } from "./session-harness-list.ts";
export { resolveSessionRecordForMutation, resolveSessionRecordForRead } from "./session-resolve.ts";

export interface HarnessAdapterDescriptor {
  id: string;
  label: string;
}

export interface BackendServiceContext {
  dataDir: string;
  storage: StorageService;
  events: BackendEventBus;
  sessions: SessionDispatchIndex;
  queues: PromptQueueService;
  harnesses: HarnessService;
  restartHarness: (harnessId: string) => Promise<void>;
  restartAllHarnesses: () => Promise<void>;
}
