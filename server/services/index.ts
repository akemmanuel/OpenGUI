/**
 * Backend service barrel. Session list/message reads use harness-only paths
 * (`listDirectorySessionsFromHarness`, `resolveSessionRecordForRead`) per ADR 0006.
 * `SessionService.listSessions` is in-memory pagination for non-product use only.
 */
import type { OpenGuiCapabilities } from "../../src/protocol/client.ts";
import type { StorageService } from "./storage-service.ts";
import type { HarnessService } from "@opengui/runtime";
import type { BackendEventBus } from "./event-bus.ts";
import type { PromptQueueService } from "./prompt-queue-service.ts";
import type { SessionService } from "./session-service.ts";

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
export { SessionService } from "./session-service.ts";
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
export type { OpenGuiCapabilities };
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
  sessions: SessionService;
  queues: PromptQueueService;
  harnesses: HarnessService;
  restartHarness: (harnessId: string) => Promise<void>;
  restartAllHarnesses: () => Promise<void>;
}
