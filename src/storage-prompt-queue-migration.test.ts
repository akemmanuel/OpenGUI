import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createSqliteStorageService } from "../server/services/storage-service.ts";

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
