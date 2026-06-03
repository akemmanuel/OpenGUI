import type { OpenGuiCapabilities } from "../../src/protocol/client.ts";
import type { StorageService } from "./storage-service.ts";
import type { ProjectService } from "./project-service.ts";
import type { HarnessService } from "./harness-service.ts";
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
  ProjectRecord,
  SessionMappingRecord,
  PromptQueueEntryRecord,
  CreateProjectInput,
  UpdateProjectInput,
  CreatePromptQueueEntryInput,
  UpdatePromptQueueEntryInput,
} from "./storage-service.ts";
export { ProjectService } from "./project-service.ts";
export { HarnessService } from "./harness-service.ts";
export type { HarnessControl, HarnessScope } from "./harness-service.ts";
export { BackendEventBus } from "./event-bus.ts";
export type { BackendEventMap } from "./event-bus.ts";
export { SessionService } from "./session-service.ts";
export type {
  SessionRecord,
  CreateSessionInput,
  UpdateSessionInput,
  ListSessionsInput,
  ListSessionsResult,
} from "./session-service.ts";
export { PromptQueueService } from "./prompt-queue-service.ts";
export type { PromptQueueEntry, CreatePromptQueueInput } from "./prompt-queue-service.ts";
export { getBackendCapabilities } from "./capabilities.ts";
export type { OpenGuiCapabilities };
export { findFilesInDirectory } from "./file-search.ts";
export { runJobsWithConcurrency } from "./concurrency.ts";
export { buildHarnessScope, runtimeSessionBelongsToProject } from "./harness-scope.ts";
export {
  rejectHarnessQuestion,
  replyToHarnessQuestion,
  respondToHarnessPermission,
} from "./harness-interactions.ts";
export {
  readJsonBody,
  toOptionalImages,
  toOptionalNullableString,
  toOptionalSelectedModel,
  toOptionalString,
  toQuestionAnswers,
  toQueueMode,
} from "./http-input.ts";
export {
  connectProjectToHarnesses,
  disconnectProjectFromHarnesses,
  getProjectHarnessStatus,
  listManagedHarnessDescriptors,
  loadProjectHarnessResources,
} from "./project-harness-actions.ts";
export {
  normalizeCreateProjectInput,
  normalizeUpdateProjectInput,
  parseCreateProjectInput,
  parseUpdateProjectInput,
} from "./project-input.ts";
export {
  createProjectRecord,
  findOrCreateProjectRecordByPath,
  getProjectRecordOrThrow,
  listProjectRecords,
  updateProjectRecord,
} from "./project-record-actions.ts";
export { dispatchNextQueuedPromptThroughHarness } from "./queue-dispatch.ts";
export {
  asSessionStatus,
  ensureSessionFromRuntime,
  toSessionRecordInputFromRuntime,
} from "./runtime-session-mapper.ts";
export {
  abortSessionThroughHarness,
  compactSessionThroughHarness,
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
export { listSessionsForRequest, querySessionsForResolvedProjects } from "./session-query.ts";
export {
  enqueueSessionPrompt,
  listProjectSessionQueues,
  listSessionQueue,
  removeSessionPrompt,
  reorderSessionPrompt,
  updateSessionPrompt,
} from "./session-queue-actions.ts";
export {
  getSessionRecordOrThrow,
  listSessionRecords,
  updateSessionRecord,
} from "./session-record-actions.ts";
export { syncProjectSessions } from "./session-sync.ts";

export interface HarnessAdapterDescriptor {
  id: string;
  label: string;
}

export interface BackendServiceContext {
  dataDir: string;
  storage: StorageService;
  events: BackendEventBus;
  projects: ProjectService;
  sessions: SessionService;
  queues: PromptQueueService;
  harnesses: HarnessService;
  restartHarness: (harnessId: string) => Promise<void>;
  restartAllHarnesses: () => Promise<void>;
}
