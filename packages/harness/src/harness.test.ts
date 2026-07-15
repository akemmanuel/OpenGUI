import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vite-plus/test";
import { HARNESS_DATABASE_FILENAME, createOpenGuiHarness, type SessionEntry } from "./index.ts";
import { FakeClock, FakeModel, SequenceIdGenerator } from "./test/index.ts";

async function temporaryDirectory() {
  return mkdtemp(join(tmpdir(), "opengui-harness-"));
}

function semanticTranscript(entries: SessionEntry[]) {
  return entries.map(({ sequence, kind, payload, createdAt }) => ({
    sequence,
    kind,
    payload,
    createdAt,
  }));
}

describe("OpenGuiHarness", () => {
  test("streams and persists model reasoning summaries", async () => {
    const dataDirectory = await temporaryDirectory();
    const projectDirectory = join(dataDirectory, "project");
    await mkdir(projectDirectory);
    const harness = createOpenGuiHarness({
      dataDirectory,
      model: new FakeModel([{ reasoningChunks: ["Inspect ", "first."], text: "Done." }]),
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
    });
    const session = await harness.createSession({
      projectDirectory,
      model: { connectionId: "fake", modelId: "reasoning-model" },
      reasoning: "high",
    });
    const reasoningDeltas: string[] = [];
    for await (const event of session.run({ text: "Solve this" })) {
      if (event.type === "reasoning_delta") reasoningDeltas.push(event.delta);
    }

    expect(reasoningDeltas).toEqual(["Inspect ", "first."]);
    expect((await session.read()).entries).toContainEqual(
      expect.objectContaining({
        kind: "assistant_reasoning",
        payload: expect.objectContaining({ text: "Inspect first." }),
      }),
    );
    await harness.close();
  });

  test("runs read through a fake model and replays the identical durable transcript", async () => {
    const dataDirectory = await temporaryDirectory();
    const projectDirectory = join(dataDirectory, "project");
    await writeFile(join(dataDirectory, "notes.txt"), "outside project");
    await mkdir(projectDirectory);
    await writeFile(join(projectDirectory, "notes.txt"), "alpha\nbeta\ngamma\n");

    const clock = new FakeClock("2026-07-10T10:00:00.000Z");
    const model = new FakeModel([
      {
        text: "I will inspect the file.",
        toolCalls: [{ id: "call-read", name: "read", input: { path: "notes.txt" } }],
      },
      { text: "The file contains alpha, beta, and gamma." },
    ]);
    const harness = createOpenGuiHarness({
      dataDirectory,
      model,
      clock,
      ids: new SequenceIdGenerator(),
    });

    const session = await harness.createSession({
      projectDirectory,
      title: "Inspect notes",
      model: { connectionId: "fake", modelId: "fake-model" },
      reasoning: "medium",
    });
    const observedKinds: string[] = [];
    for await (const event of session.run({ text: "What is in notes.txt?" })) {
      if (event.type === "entry_appended") observedKinds.push(event.entry.kind);
    }

    expect(observedKinds).toEqual([
      "user_message",
      "run_started",
      "assistant_message",
      "tool_call",
      "tool_result",
      "assistant_message",
      "run_completed",
    ]);
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]?.context.at(-1)).toMatchObject({
      type: "tool_result",
      toolCallId: "call-read",
      name: "read",
      output: { content: "alpha\nbeta\ngamma\n" },
    });

    const beforeRestart = await session.read();
    expect(beforeRestart.status).toBe("idle");
    expect(beforeRestart.entries.map((entry) => entry.kind)).toEqual([
      "session_created",
      "model_changed",
      "reasoning_changed",
      "user_message",
      "run_started",
      "assistant_message",
      "tool_call",
      "tool_result",
      "assistant_message",
      "run_completed",
    ]);
    await harness.close();

    const reopenedHarness = createOpenGuiHarness({
      dataDirectory,
      model: new FakeModel([]),
      clock,
      ids: new SequenceIdGenerator(100),
    });
    const reopened = await reopenedHarness.openSession(beforeRestart.id);
    const afterRestart = await reopened.read();

    expect(semanticTranscript(afterRestart.entries)).toEqual(
      semanticTranscript(beforeRestart.entries),
    );
    expect(afterRestart).toMatchObject({
      id: beforeRestart.id,
      projectDirectory,
      title: "Inspect notes",
      model: { connectionId: "fake", modelId: "fake-model" },
      reasoning: "medium",
      status: "idle",
    });
    await reopenedHarness.close();
  });

  test("uses its own database and leaves a legacy opengui.sqlite sessions table untouched", async () => {
    const dataDirectory = await temporaryDirectory();
    const legacyPath = join(dataDirectory, "opengui.sqlite");
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, marker TEXT NOT NULL)");
    legacy.prepare("INSERT INTO sessions (id, marker) VALUES (?, ?)").run("legacy-1", "keep-me");
    legacy.close();

    const harness = createOpenGuiHarness({
      dataDirectory,
      model: new FakeModel([]),
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
    });
    expect(await harness.listSessions(dataDirectory)).toEqual([]);
    await harness.close();

    expect(await readFile(legacyPath)).not.toHaveLength(0);
    const reopenedLegacy = new DatabaseSync(legacyPath, { readOnly: true });
    expect(reopenedLegacy.prepare("SELECT id, marker FROM sessions").get()).toMatchObject({
      id: "legacy-1",
      marker: "keep-me",
    });
    reopenedLegacy.close();

    const harnessDatabase = new DatabaseSync(join(dataDirectory, HARNESS_DATABASE_FILENAME), {
      readOnly: true,
    });
    expect(
      harnessDatabase
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_entries'")
        .get(),
    ).toMatchObject({ name: "session_entries" });
    harnessDatabase.close();
  });

  test("upgrades the early v1 Session table before creating a Session", async () => {
    const dataDirectory = await temporaryDirectory();
    const databasePath = join(dataDirectory, HARNESS_DATABASE_FILENAME);
    const earlyDatabase = new DatabaseSync(databasePath);
    earlyDatabase.exec(`
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
      INSERT INTO sessions (
        id, project_directory, title, model_json, reasoning, created_at, updated_at
      ) VALUES (
        'early-session', '${dataDirectory.replaceAll("'", "''")}', 'Preserved session',
        '{"connectionId":"fake","modelId":"old-model"}', 'low',
        '2026-07-09T10:00:00.000Z', '2026-07-09T10:00:00.000Z'
      );
      PRAGMA user_version = 1;
    `);
    earlyDatabase.close();

    const harness = createOpenGuiHarness({
      dataDirectory,
      model: new FakeModel([]),
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
    });
    const session = await harness.createSession({
      projectDirectory: dataDirectory,
      model: { connectionId: "fake", modelId: "fake-model" },
      reasoning: "medium",
    });

    expect(await session.read()).toMatchObject({
      model: { connectionId: "fake", modelId: "fake-model" },
      reasoning: "medium",
    });
    expect(await (await harness.openSession("early-session")).read()).toMatchObject({
      id: "early-session",
      title: "Preserved session",
    });
    await harness.close();

    const upgraded = new DatabaseSync(databasePath, { readOnly: true });
    expect(
      (upgraded.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    ).toEqual(["id", "project_directory", "title", "created_at", "updated_at"]);
    expect(
      upgraded.prepare("SELECT name FROM sqlite_master WHERE name = 'kysely_migration'").get(),
    ).toMatchObject({ name: "kysely_migration" });
    upgraded.close();
  });

  test("recovers a run left active by a stopped Host as interrupted", async () => {
    const dataDirectory = await temporaryDirectory();
    const clock = new FakeClock("2026-07-10T10:00:00.000Z");
    const stoppedHost = createOpenGuiHarness({
      dataDirectory,
      model: new FakeModel([{ text: "This turn must never finish." }]),
      clock,
      ids: new SequenceIdGenerator(),
    });
    const session = await stoppedHost.createSession({
      projectDirectory: dataDirectory,
      model: { connectionId: "fake", modelId: "fake-model" },
      reasoning: "low",
    });
    const run = session.run({ text: "Start work" })[Symbol.asyncIterator]();
    expect((await run.next()).value).toMatchObject({
      type: "entry_appended",
      entry: { kind: "user_message" },
    });
    expect((await run.next()).value).toMatchObject({
      type: "entry_appended",
      entry: { kind: "run_started" },
    });

    clock.advance(1_000);
    const restartedHost = createOpenGuiHarness({
      dataDirectory,
      model: new FakeModel([]),
      clock,
      ids: new SequenceIdGenerator(100),
    });
    const recovered = await restartedHost.openSession((await session.read()).id);
    const snapshot = await recovered.read();

    expect(snapshot.status).toBe("interrupted");
    expect(snapshot.entries.at(-1)).toMatchObject({
      kind: "run_interrupted",
      payload: { runId: "run-5" },
      createdAt: "2026-07-10T10:00:01.000Z",
    });
    await restartedHost.close();
    await run.return?.();
    await stoppedHost.close();
  });

  test("scopes, updates, orders, and deletes Sessions through Session handles", async () => {
    const dataDirectory = await temporaryDirectory();
    const projectA = join(dataDirectory, "project-a");
    const projectB = join(dataDirectory, "project-b");
    const clock = new FakeClock("2026-07-10T10:00:00.000Z");
    const harness = createOpenGuiHarness({
      dataDirectory,
      model: new FakeModel([]),
      clock,
      ids: new SequenceIdGenerator(),
    });
    const first = await harness.createSession({
      projectDirectory: projectA,
      title: "First",
      model: { connectionId: "fake", modelId: "model-a" },
      reasoning: "low",
    });
    clock.advance(1_000);
    const second = await harness.createSession({
      projectDirectory: projectA,
      title: "Second",
      model: { connectionId: "fake", modelId: "model-a" },
      reasoning: "low",
    });
    await harness.createSession({
      projectDirectory: projectB,
      title: "Other project",
      model: { connectionId: "fake", modelId: "model-a" },
      reasoning: "low",
    });

    clock.advance(1_000);
    await first.rename("Renamed");
    await first.setModel({ connectionId: "custom", modelId: "model-b" });
    await first.setReasoning("high");

    expect((await harness.listSessions(projectA)).map((session) => session.title)).toEqual([
      "Renamed",
      "Second",
    ]);
    expect(await first.read()).toMatchObject({
      title: "Renamed",
      model: { connectionId: "custom", modelId: "model-b" },
      reasoning: "high",
    });
    expect(await harness.listSessions(projectB)).toHaveLength(1);

    const secondId = (await second.read()).id;
    await second.delete();
    await expect(harness.openSession(secondId)).rejects.toThrow(`Session not found: ${secondId}`);
    expect(await harness.listSessions(projectA)).toHaveLength(1);
    await harness.close();
  });

  test("persists and dispatches follow-ups in FIFO order after the active Run", async () => {
    const dataDirectory = await temporaryDirectory();
    const model = new FakeModel([
      { text: "First complete" },
      { text: "Second complete" },
      { text: "Third complete" },
    ]);
    const harness = createOpenGuiHarness({
      dataDirectory,
      model,
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
    });
    const session = await harness.createSession({
      projectDirectory: dataDirectory,
      model: { connectionId: "fake", modelId: "fake-model" },
      reasoning: "medium",
    });
    const stream = session.run({ text: "First" })[Symbol.asyncIterator]();
    await stream.next();
    await stream.next();
    await session.followUp({ text: "Second" });
    await session.followUp({ text: "Third" });

    while (!(await stream.next()).done) {
      // Drain the stream through all persisted follow-ups.
    }

    const snapshot = await session.read();
    expect(
      snapshot.entries
        .filter((entry) => entry.kind === "user_message")
        .map((entry) => entry.payload.text),
    ).toEqual(["First", "Second", "Third"]);
    expect(snapshot.followUps).toEqual([]);
    expect(model.requests).toHaveLength(3);
    await harness.close();
  });

  test("executes ordered write and exact edit calls before the next model turn", async () => {
    const dataDirectory = await temporaryDirectory();
    const projectDirectory = join(dataDirectory, "project");
    const outputPath = join(projectDirectory, "nested", "greeting.txt");
    const model = new FakeModel([
      {
        toolCalls: [
          {
            id: "call-write",
            name: "write",
            input: {
              path: "nested/greeting.txt",
              content: "Hello old world\n",
              createParents: true,
            },
          },
          {
            id: "call-edit",
            name: "edit",
            input: {
              path: "nested/greeting.txt",
              oldText: "old world",
              newText: "OpenGUI",
            },
          },
        ],
      },
      { text: "The greeting is ready." },
    ]);
    const harness = createOpenGuiHarness({
      dataDirectory,
      model,
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
    });
    const session = await harness.createSession({
      projectDirectory,
      model: { connectionId: "fake", modelId: "fake-model" },
      reasoning: "medium",
    });

    for await (const _event of session.run({ text: "Create the greeting" })) {
      // Drain the Run.
    }

    expect(await readFile(outputPath, "utf8")).toBe("Hello OpenGUI\n");
    const toolResults = (await session.read()).entries.filter(
      (entry) => entry.kind === "tool_result",
    );
    expect(toolResults).toHaveLength(2);
    expect(toolResults[1]).toMatchObject({
      payload: {
        name: "edit",
        output: {
          replacements: 1,
          diff: "--- nested/greeting.txt\n+++ nested/greeting.txt\n@@\n-Hello old world\n+Hello OpenGUI\n",
        },
      },
    });
    await harness.close();
  });

  test("runs shell with bounded returned output, retained full output, and timeout", async () => {
    const dataDirectory = await temporaryDirectory();
    const projectDirectory = join(dataDirectory, "project");
    await mkdir(projectDirectory);
    const model = new FakeModel([
      {
        toolCalls: [
          {
            id: "call-large",
            name: "shell",
            input: { command: `node -e "process.stdout.write('x'.repeat(70000))"` },
          },
          {
            id: "call-timeout",
            name: "shell",
            input: { command: `node -e "setTimeout(() => {}, 5000)"`, timeoutMs: 50 },
          },
        ],
      },
      { text: "Shell calls finished." },
    ]);
    const harness = createOpenGuiHarness({
      dataDirectory,
      model,
      shell: { executable: "/bin/sh" },
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
    });
    const session = await harness.createSession({
      projectDirectory,
      model: { connectionId: "fake", modelId: "fake-model" },
      reasoning: "medium",
    });

    for await (const _event of session.run({ text: "Exercise shell output" })) {
      // Drain the Run.
    }

    const results = (await session.read()).entries.filter((entry) => entry.kind === "tool_result");
    const largeOutput = results[0]?.payload.output as {
      output: string;
      truncated: boolean;
      fullOutputPath: string;
      exitCode: number;
    };
    expect(largeOutput).toMatchObject({ truncated: true, exitCode: 0 });
    expect(Buffer.byteLength(largeOutput.output)).toBeLessThanOrEqual(65_536);
    expect(await readFile(largeOutput.fullOutputPath, "utf8")).toHaveLength(70_000);
    expect(results[1]).toMatchObject({
      payload: { output: { timedOut: true, exitCode: null } },
    });
    await harness.close();
  });

  test.skipIf(process.platform === "win32")(
    "aborts shell descendants and records an aborted Run",
    async () => {
      const dataDirectory = await temporaryDirectory();
      const projectDirectory = join(dataDirectory, "project");
      const descendantMarker = join(projectDirectory, "descendant.txt");
      await mkdir(projectDirectory);
      const model = new FakeModel([
        {
          toolCalls: [
            {
              id: "call-abort",
              name: "shell",
              input: {
                command: "sh -c 'sleep 1; echo alive > descendant.txt' & sleep 5",
              },
            },
          ],
        },
      ]);
      const harness = createOpenGuiHarness({
        dataDirectory,
        model,
        shell: { executable: "/bin/sh" },
        clock: new FakeClock("2026-07-10T10:00:00.000Z"),
        ids: new SequenceIdGenerator(),
      });
      const session = await harness.createSession({
        projectDirectory,
        model: { connectionId: "fake", modelId: "fake-model" },
        reasoning: "medium",
      });
      const stream = session.run({ text: "Start child processes" })[Symbol.asyncIterator]();
      await stream.next();
      await stream.next();
      await stream.next();
      const shellCompletion = stream.next();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await session.abort();
      expect(await shellCompletion).toMatchObject({
        value: {
          type: "entry_appended",
          entry: { kind: "tool_result", payload: { output: { aborted: true } } },
        },
      });
      while (!(await stream.next()).done) {
        // Drain the terminal Run event.
      }

      expect((await session.read()).entries.at(-1)?.kind).toBe("run_aborted");
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await expect(readFile(descendantMarker, "utf8")).rejects.toThrow("ENOENT");
      await harness.close();
    },
  );
});
