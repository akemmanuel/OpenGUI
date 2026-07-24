import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createOpenGuiHarness, HARNESS_DATABASE_FILENAME } from "./index.ts";
import { FakeModel } from "./test/index.ts";
import { seeded } from "./test/seeded.ts";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true }))));

describe("seeded persistence migration properties", () => {
  test("24 early-v1 Sessions retain entries and migrate each missing selection exactly once", async () => {
    const random = seeded(0x4d494752);
    const dataDirectory = await mkdtemp(join(tmpdir(), "opengui-migration-property-"));
    cleanup.push(dataDirectory);
    const database = new DatabaseSync(join(dataDirectory, HARNESS_DATABASE_FILENAME));
    database.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, project_directory TEXT NOT NULL, title TEXT NOT NULL,
        model_json TEXT NOT NULL, reasoning TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE session_entries (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(session_id, sequence)
      );
    `);
    const expected = new Map<string, { model: object; entryCount: number }>();
    const insertSession = database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)");
    const insertEntry = database.prepare("INSERT INTO session_entries VALUES (?, ?, ?, ?, ?, ?)");
    for (let iteration = 0; iteration < 24; iteration += 1) {
      const id = `session-${iteration}`;
      const model = { connectionId: `connection-${iteration}`, modelId: `模型-${random.next()}` };
      insertSession.run(
        id,
        dataDirectory,
        `Title 🙂 ${iteration}`,
        JSON.stringify(model),
        random.pick(["none", "low", "medium", "high"]),
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      const existingCount = random.int(0, 8);
      for (let sequence = 1; sequence <= existingCount; sequence += 1) {
        insertEntry.run(
          `${id}:existing-${sequence}`,
          id,
          sequence,
          "user_message",
          JSON.stringify({ text: `before-${sequence}` }),
          "2026-01-01T00:00:00.000Z",
        );
      }
      expected.set(id, { model, entryCount: existingCount + 2 });
    }
    database.close();

    const harness = createOpenGuiHarness({ dataDirectory, model: new FakeModel([]) });
    const firstSnapshots = new Map();
    for (const [id, fixture] of expected) {
      const first = await (await harness.openSession(id)).read();
      firstSnapshots.set(id, first.entries);
      expect(first.model).toEqual(fixture.model);
      expect(first.entries.map((entry) => entry.sequence)).toEqual(
        Array.from({ length: fixture.entryCount }, (_, index) => index + 1),
      );
      expect(first.entries.filter((entry) => entry.kind === "model_changed")).toHaveLength(1);
      expect(first.entries.filter((entry) => entry.kind === "reasoning_changed")).toHaveLength(1);
    }
    await harness.close();

    const reopened = createOpenGuiHarness({ dataDirectory, model: new FakeModel([]) });
    for (const id of expected.keys()) {
      expect((await (await reopened.openSession(id)).read()).entries).toEqual(
        firstSnapshots.get(id),
      );
    }
    await reopened.close();
  });
});
