import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createOpenGuiHarness, HARNESS_DATABASE_FILENAME, OpenAiChatTransport } from "./index.ts";
import type { ModelRequest, ModelStreamEvent, ModelTransport } from "./models/transport.ts";
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

  test("fails migration without dropping a corrupt legacy model selection", async () => {
    const dataDirectory = await directory();
    const databasePath = join(dataDirectory, HARNESS_DATABASE_FILENAME);
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, project_directory TEXT NOT NULL, title TEXT NOT NULL,
        model_json TEXT NOT NULL, reasoning TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO sessions VALUES (
        'corrupt', '/project', 'Corrupt', '{not-json', 'high',
        '2026-07-09T10:00:00.000Z', '2026-07-09T10:00:00.000Z'
      );
    `);
    database.close();

    const harness = createOpenGuiHarness({
      dataDirectory,
      model: new FakeModel([]),
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
    });
    await expect(harness.openSession("corrupt")).rejects.toThrow(
      "legacy model selection is corrupt",
    );

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    expect(
      (preserved.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    ).toContain("model_json");
    preserved.close();
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

  test("abort cancels the model request, preserves queued follow-ups, and releases the Session", async () => {
    const dataDirectory = await directory();
    let firstRequestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstRequestStarted = resolve;
    });
    let request = 0;
    const model: ModelTransport = {
      async *stream(_input: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
        request += 1;
        if (request === 1) {
          firstRequestStarted();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        yield { type: "text_delta", delta: request === 2 ? "recovered" : "queued" };
        yield { type: "completed" };
      },
    };
    const harness = createOpenGuiHarness({
      dataDirectory,
      model,
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
    });
    const session = await harness.createSession({
      projectDirectory: dataDirectory,
      model: { connectionId: "fake", modelId: "fake" },
      reasoning: "none",
    });
    const events: string[] = [];
    const activeRun = (async () => {
      for await (const event of session.run({ text: "active" })) {
        if (event.type === "entry_appended") events.push(event.entry.kind);
      }
    })();
    await started;
    const queued = await session.followUp({ text: "queued" });

    await session.abort();
    await activeRun;

    expect(events.at(-1)).toBe("run_aborted");
    expect((await session.read()).followUps.map((item) => item.id)).toEqual([queued.id]);

    for await (const _event of session.run({ text: "recovery" })) {
      // The newly accepted Run completes, then dispatches the preserved queue.
    }
    expect(
      (await session.read()).entries
        .filter((entry) => entry.kind === "user_message")
        .map((entry) => entry.payload.text),
    ).toEqual(["active", "recovery", "queued"]);
    expect((await session.read()).followUps).toEqual([]);
    await harness.close();
  });

  test("abort after the final model delta does not persist a completed assistant turn", async () => {
    const dataDirectory = await directory();
    const harness = createOpenGuiHarness({
      dataDirectory,
      model: new FakeModel([{ textChunks: ["must not persist"] }]),
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
    });
    const session = await harness.createSession({
      projectDirectory: dataDirectory,
      model: { connectionId: "fake", modelId: "fake" },
      reasoning: "none",
    });
    const stream = session.run({ text: "stop after the delta" })[Symbol.asyncIterator]();
    await stream.next();
    await stream.next();
    expect(await stream.next()).toMatchObject({
      value: { type: "assistant_delta", delta: "must not persist" },
    });

    await session.abort();
    while (!(await stream.next()).done) {
      // Drain the terminal lifecycle event.
    }

    const entries = (await session.read()).entries;
    expect(entries.some((entry) => entry.kind === "assistant_message")).toBe(false);
    expect(entries.at(-1)?.kind).toBe("run_aborted");
    await harness.close();
  });

  test("abort before a filesystem tool boundary prevents the tool effect", async () => {
    const dataDirectory = await directory();
    const harness = createOpenGuiHarness({
      dataDirectory,
      model: new FakeModel([
        {
          toolCalls: [
            {
              id: "write-after-abort",
              name: "write",
              input: { path: "forbidden.txt", content: "written" },
            },
          ],
        },
      ]),
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
    });
    const session = await harness.createSession({
      projectDirectory: dataDirectory,
      model: { connectionId: "fake", modelId: "fake" },
      reasoning: "none",
    });
    const stream = session.run({ text: "write" })[Symbol.asyncIterator]();
    await stream.next();
    await stream.next();
    expect(await stream.next()).toMatchObject({
      value: { type: "entry_appended", entry: { kind: "tool_call" } },
    });

    await session.abort();
    while (!(await stream.next()).done) {
      // Drain the terminal lifecycle event.
    }

    await expect(
      import("node:fs/promises").then(({ readFile }) =>
        readFile(join(dataDirectory, "forbidden.txt")),
      ),
    ).rejects.toThrow("ENOENT");
    expect((await session.read()).entries.at(-1)?.kind).toBe("run_aborted");
    await harness.close();
  });

  test("close aborts an active model request and waits for its terminal entry", async () => {
    const dataDirectory = await directory();
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const model: ModelTransport = {
      async *stream(_request, signal) {
        observedSignal = signal;
        started();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        yield { type: "completed" };
      },
    };
    const harness = createOpenGuiHarness({
      dataDirectory,
      model,
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
    });
    const session = await harness.createSession({
      projectDirectory: dataDirectory,
      model: { connectionId: "fake", modelId: "fake" },
      reasoning: "none",
    });
    const run = (async () => {
      for await (const _event of session.run({ text: "active" })) {
        // Keep the model request actively consumed while close coordinates shutdown.
      }
    })();
    await modelStarted;

    await harness.close();
    await run;

    expect(observedSignal?.aborted).toBe(true);
    const database = new DatabaseSync(join(dataDirectory, HARNESS_DATABASE_FILENAME), {
      readOnly: true,
    });
    expect(
      database.prepare("SELECT kind FROM session_entries ORDER BY sequence DESC LIMIT 1").get(),
    ).toMatchObject({ kind: "run_aborted" });
    database.close();
  });

  test("a partial model failure is durable, does not promote deltas to history, and permits retry", async () => {
    const dataDirectory = await directory();
    let request = 0;
    const model: ModelTransport = {
      async *stream() {
        request += 1;
        if (request === 1) {
          yield { type: "text_delta", delta: "partial secret draft" };
          throw new Error("network disconnected");
        }
        yield { type: "text_delta", delta: "recovered" };
        yield { type: "completed" };
      },
    };
    const harness = createOpenGuiHarness({
      dataDirectory,
      model,
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
    });
    const session = await harness.createSession({
      projectDirectory: dataDirectory,
      model: { connectionId: "fake", modelId: "fake" },
      reasoning: "none",
    });

    const first = async () => {
      for await (const _event of session.run({ text: "first" })) {
        // Drain the failing stream.
      }
    };
    await expect(first()).rejects.toThrow("network disconnected");
    expect(await session.read()).toMatchObject({ status: "failed" });
    expect(
      (await session.read()).entries.some(
        (entry) =>
          entry.kind === "assistant_message" && entry.payload.text === "partial secret draft",
      ),
    ).toBe(false);

    for await (const _event of session.run({ text: "retry" })) {
      // Retry through the same public Session handle.
    }
    expect(await session.read()).toMatchObject({ status: "idle" });
    await harness.close();
  });

  test("corrupt durable entry JSON fails closed instead of fabricating transcript data", async () => {
    const dataDirectory = await directory();
    const harness = createOpenGuiHarness({
      dataDirectory,
      model: new FakeModel([]),
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
    });
    const session = await harness.createSession({
      projectDirectory: dataDirectory,
      model: { connectionId: "fake", modelId: "fake" },
      reasoning: "none",
    });
    const sessionId = (await session.read()).id;
    await harness.close();

    const database = new DatabaseSync(join(dataDirectory, HARNESS_DATABASE_FILENAME));
    database
      .prepare("UPDATE session_entries SET payload_json = ? WHERE session_id = ? AND sequence = 1")
      .run("{corrupt", sessionId);
    database.close();

    const reopened = createOpenGuiHarness({
      dataDirectory,
      model: new FakeModel([]),
      clock: new FakeClock("2026-07-10T10:00:01.000Z"),
      ids: new SequenceIdGenerator(100),
    });
    await expect(reopened.openSession(sessionId)).rejects.toThrow();
  });

  test("provider credentials are never persisted in the Session database", async () => {
    const dataDirectory = await directory();
    const credential = "sk-provider-secret-must-stay-ephemeral";
    const model = new OpenAiChatTransport({
      fetchImpl: (async () => new Response("data: [DONE]\n\n", { status: 200 })) as typeof fetch,
    });
    model.setConnections([
      {
        id: "private",
        label: "Private connection",
        baseUrl: "https://example.test/v1",
        apiKey: credential,
        modelIds: ["model"],
      },
    ]);
    const harness = createOpenGuiHarness({
      dataDirectory,
      model,
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
    });
    const session = await harness.createSession({
      projectDirectory: dataDirectory,
      model: { connectionId: "private", modelId: "model" },
      reasoning: "none",
    });
    for await (const _event of session.run({ text: "hello" })) {
      // Complete one authenticated request before inspecting durable storage.
    }
    await harness.close();

    expect(
      (await readFile(join(dataDirectory, HARNESS_DATABASE_FILENAME))).includes(credential),
    ).toBe(false);
  });
});
