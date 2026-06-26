import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  createJsonStorageService,
  createSqliteStorageService,
} from "../server/services/storage-service.ts";

describe("sqlite prompt_queue legacy migration", () => {
  test("adds harness columns and can enqueue after legacy schema", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "opengui-storage-"));
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(join(dataDir, "opengui.sqlite"));
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          raw_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          harness_id TEXT NOT NULL
        );
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          canonical_path TEXT NOT NULL
        );
        CREATE TABLE prompt_queue (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          queue_order INTEGER NOT NULL,
          text TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          mode TEXT NOT NULL
        );
        INSERT INTO projects (id, path, canonical_path) VALUES ('p1', '/repo', '/repo');
        INSERT INTO sessions (id, raw_id, project_id, harness_id)
          VALUES ('session_1', 'raw-1', 'p1', 'opencode');
      `);
      db.close();

      const storage = await createSqliteStorageService(dataDir);
      const entry = await storage.createPromptQueueEntry({
        sessionId: "session_1",
        harnessId: "opencode",
        projectDirectory: "/repo",
        harnessSessionId: "raw-1",
        text: "queued",
        mode: "queue",
      });

      expect(entry.text).toBe("queued");
      const listed = await storage.listPromptQueue("session_1");
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        harnessId: "opencode",
        projectDirectory: "/repo",
        harnessSessionId: "raw-1",
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("migratePromptQueueSessionId", () => {
  test("json storage rewrites session_id on queued rows", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "opengui-pq-json-"));
    try {
      writeFileSync(
        join(dataDir, "prompt-queue.json"),
        JSON.stringify([
          {
            id: "queue_1",
            sessionId: "session_old",
            harnessId: "pi",
            projectDirectory: "/repo",
            harnessSessionId: "raw-1",
            text: "hello",
            createdAt: 1,
            mode: "queue",
            order: 0,
          },
        ]),
      );
      const storage = createJsonStorageService(dataDir);
      const count = await storage.migratePromptQueueSessionId("session_old", "pi:raw-1");
      expect(count).toBe(1);
      const listed = await storage.listPromptQueue("pi:raw-1");
      expect(listed).toHaveLength(1);
      expect(listed[0]?.sessionId).toBe("pi:raw-1");
      expect(await storage.listPromptQueue("session_old")).toHaveLength(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("sqlite storage rewrites session_id on queued rows", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "opengui-pq-sqlite-"));
    try {
      const storage = await createSqliteStorageService(dataDir);
      await storage.createPromptQueueEntry({
        sessionId: "opencode:legacy-wire",
        harnessId: "opencode",
        projectDirectory: "/repo",
        harnessSessionId: "raw-9",
        text: "queued",
        mode: "queue",
      });
      const count = await storage.migratePromptQueueSessionId(
        "opencode:legacy-wire",
        "opencode:raw-9",
      );
      expect(count).toBe(1);
      expect(await storage.listPromptQueue("opencode:raw-9")).toHaveLength(1);
      expect(await storage.listPromptQueue("opencode:legacy-wire")).toHaveLength(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
