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
