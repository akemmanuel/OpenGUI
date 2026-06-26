import { describe, expect, test } from "vite-plus/test";
import { PromptQueueService } from "../server/services/prompt-queue-service.ts";
import type { BackendServiceContext } from "../server/services/index.ts";
import type { PromptQueueEntryRecord, StorageService } from "../server/services/storage-service.ts";
import type { SessionRecord } from "../server/services/session-types.ts";

function makeStorage(entries: PromptQueueEntryRecord[] = []): StorageService {
  return {
    listPromptQueue: async () => entries,
    createPromptQueueEntry: async (input) => {
      const entry: PromptQueueEntryRecord = {
        id: input.id ?? "queue-1",
        sessionId: input.sessionId,
        harnessId: input.harnessId,
        projectDirectory: input.projectDirectory,
        harnessSessionId: input.harnessSessionId,
        text: input.text,
        createdAt: input.createdAt ?? 1,
        model: input.model,
        agent: input.agent,
        variant: input.variant,
        mode: input.mode,
        order: input.order ?? entries.length,
      };
      entries.push(entry);
      return entry;
    },
    replacePromptQueue: async (_sessionId, next) => {
      entries.splice(0, entries.length, ...next);
      return entries;
    },
  } as StorageService;
}

describe("PromptQueueService", () => {
  test("uses Session metadata directory when Project record is missing", async () => {
    const session: SessionRecord = {
      id: "session_1",
      rawId: "raw-1",
      directory: "missing-project",
      harnessId: "opencode",
      title: "Running",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      metadata: { directory: "/repo" },
    };
    const storage = makeStorage();
    const services = {
      storage,
      sessions: {
        getSession: async () => session,
      },
      harnesses: {},
      events: undefined,
    } as unknown as BackendServiceContext;

    const queue = new PromptQueueService(services, async (path) =>
      path === "missing-project" ? "/repo" : path,
    );

    const entries = await queue.enqueue(
      "opencode:raw-1",
      { text: "Continue", mode: "queue" },
      { directory: "/repo", harnessId: session.harnessId },
    );

    expect(entries).toEqual([
      expect.objectContaining({
        sessionId: "opencode:raw-1",
        canonicalSessionId: "session_1",
        projectDirectory: "/repo",
        text: "Continue",
      }),
    ]);
  });
});
