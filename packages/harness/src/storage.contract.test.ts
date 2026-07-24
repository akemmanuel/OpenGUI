import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createOpenGuiHarness, HARNESS_DATABASE_FILENAME } from "./index.ts";
import { FakeClock, FakeModel, SequenceIdGenerator } from "./test/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "opengui-storage-contract-"));
  temporaryDirectories.push(path);
  return path;
}

describe("Harness storage contracts", () => {
  test("migrates early v1 model and reasoning selections into the durable entry log", async () => {
    const dataDirectory = await directory();
    const database = new DatabaseSync(join(dataDirectory, HARNESS_DATABASE_FILENAME));
    database.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        project_directory TEXT NOT NULL,
        title TEXT NOT NULL,
        model_json TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE session_entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );
      CREATE TABLE session_follow_ups (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        prompt_json TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
      INSERT INTO sessions VALUES (
        'early', '/project', 'Early', '{"connectionId":"legacy","modelId":"model-a"}',
        'high', '2026-07-09T10:00:00.000Z', '2026-07-09T10:00:00.000Z'
      );
      INSERT INTO session_entries VALUES (
        'existing-entry', 'early', 1, 'session_created', '{"title":"Early"}',
        '2026-07-09T10:00:00.000Z'
      );
      PRAGMA user_version = 1;
    `);
    database.close();

    const harness = createOpenGuiHarness({
      dataDirectory,
      model: new FakeModel([]),
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
    });
    const snapshot = await (await harness.openSession("early")).read();

    expect(snapshot.model).toEqual({ connectionId: "legacy", modelId: "model-a" });
    expect(snapshot.reasoning).toBe("high");
    expect(snapshot.entries.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    await harness.close();
  });

  test("serializes concurrent metadata changes without losing entries", async () => {
    const dataDirectory = await directory();
    const harness = createOpenGuiHarness({
      dataDirectory,
      model: new FakeModel([]),
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
    });
    const session = await harness.createSession({
      projectDirectory: dataDirectory,
      model: { connectionId: "initial", modelId: "initial" },
      reasoning: "none",
    });

    await Promise.all([
      session.rename("Concurrent"),
      session.setModel({ connectionId: "next", modelId: "model-b" }),
      session.setReasoning("high"),
    ]);
    const snapshot = await session.read();

    expect(snapshot).toMatchObject({
      title: "Concurrent",
      model: { connectionId: "next", modelId: "model-b" },
      reasoning: "high",
    });
    expect(snapshot.entries.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    await harness.close();
  });

  test("rejects a concurrent Run and remains usable after the first Run completes", async () => {
    const dataDirectory = await directory();
    const harness = createOpenGuiHarness({
      dataDirectory,
      model: new FakeModel([{ textChunks: ["first", " done"] }, { text: "second" }]),
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
    });
    const session = await harness.createSession({
      projectDirectory: dataDirectory,
      model: { connectionId: "fake", modelId: "fake" },
      reasoning: "none",
    });
    const first = session.run({ text: "first" })[Symbol.asyncIterator]();
    await first.next();
    await first.next();

    const competing = session.run({ text: "competing" })[Symbol.asyncIterator]();
    await expect(competing.next()).rejects.toThrow("A run is already active for this Session");
    while (!(await first.next()).done) {
      // Drain the accepted Run.
    }
    for await (const _event of session.run({ text: "second" })) {
      // A completed Run releases the Session arbitration slot.
    }

    expect(
      (await session.read()).entries
        .filter((entry) => entry.kind === "user_message")
        .map((entry) => entry.payload.text),
    ).toEqual(["first", "second"]);
    await harness.close();
  });
});
