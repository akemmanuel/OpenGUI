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
  test("advertises project skills in the system prompt and loads them with read", async () => {
    const dataDirectory = await temporaryDirectory();
    const homeDirectory = join(dataDirectory, "home");
    const projectDirectory = join(dataDirectory, "project");
    const skillDir = join(projectDirectory, ".agents", "skills", "code-review");
    await mkdir(skillDir, { recursive: true });
    await mkdir(homeDirectory, { recursive: true });
    await mkdir(projectDirectory, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    await writeFile(
      skillPath,
      `---
name: code-review
description: Review code changes and pull requests. Use when reviewing diffs or PRs.
---

# Code review

1. Read the diff.
2. Report findings.
`,
    );

    const model = new FakeModel([
      {
        text: "Loading skill.",
        toolCalls: [{ id: "call-skill", name: "read", input: { path: skillPath } }],
      },
      { text: "Skill loaded." },
    ]);
    const harness = createOpenGuiHarness({
      dataDirectory,
      homeDirectory,
      model,
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
    });
    const session = await harness.createSession({
      projectDirectory,
      model: { connectionId: "fake", modelId: "fake-model" },
      reasoning: "none",
    });

    for await (const _event of session.run({ text: "Review my PR" })) {
      // drain
    }

    expect(model.requests[0]?.systemPrompt).toContain(`- code-review:`);
    expect(model.requests[0]?.systemPrompt).toContain(`${join(dataDirectory, "skill-pins")}/`);
    expect(model.requests[0]?.systemPrompt).not.toContain(skillPath);
    expect(model.requests[0]?.systemPrompt).toContain("read that SKILL.md");
    expect(model.requests[1]?.context.at(-1)).toMatchObject({
      type: "tool_result",
      toolCallId: "call-skill",
      name: "read",
      output: expect.objectContaining({
        content: expect.stringContaining("# Code review"),
      }),
    });
    await harness.close();
  });

  test("compacts through a hidden warm-context handoff and resumes from its temp folder", async () => {
    const dataDirectory = await temporaryDirectory();
    const handoffRoot = join(dataDirectory, "tmp");
    const projectDirectory = join(dataDirectory, "project");
    await mkdir(projectDirectory);
    const handoffDirectory = join(handoffRoot, "opengui", "handoffs", "session-1", "run-10");
    const handoffPath = join(handoffDirectory, "HANDOFF.md");
    const model = new FakeModel([
      { text: `Long work state ${"x".repeat(1_000)}` },
      {
        toolCalls: [
          {
            id: "write-handoff",
            name: "write",
            input: {
              path: handoffPath,
              content:
                "# Handoff\n\n## Goal\nContinue the task.\n\n## Current state\nInitial work is done.\n\n## Relevant files\n- README.md\n\n## Next steps\n1. Continue.\n",
            },
          },
        ],
      },
      { text: "Handoff ready." },
      { text: "Continued from the handoff." },
    ]);
    const harness = createOpenGuiHarness({
      dataDirectory,
      model,
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
      compaction: {
        contextWindowTokens: 300,
        thresholdRatio: 0.7,
        tempDirectory: handoffRoot,
      },
    });
    const session = await harness.createSession({
      projectDirectory,
      model: { connectionId: "fake", modelId: "fake-model" },
      reasoning: "none",
    });

    for await (const _event of session.run({ text: "Start the long task", skills: [] })) {
      // drain
    }
    const events = [];
    for await (const event of session.run({ text: "Continue" })) events.push(event);

    expect(model.requests[1]?.systemPrompt).toBe(model.requests[0]?.systemPrompt);
    expect(model.requests[1]?.tools).toEqual(model.requests[0]?.tools);
    expect(model.requests[1]?.context.at(-1)).toMatchObject({
      type: "user_message",
      text: expect.stringContaining(handoffPath),
    });
    expect(model.requests[1]?.context.at(-1)).toMatchObject({
      text: expect.stringContaining("STOP working on the task"),
    });
    expect(model.requests[3]?.context).toEqual([
      expect.objectContaining({
        type: "user_message",
        text: expect.stringContaining(`Read and inspect the handoff folder at ${handoffDirectory}`),
      }),
    ]);
    expect(await readFile(handoffPath, "utf8")).toContain("## Next steps");

    const snapshot = await session.read();
    const compactions = snapshot.entries.filter((entry) => entry.kind === "compaction");
    expect(compactions.map((entry) => entry.payload.status)).toEqual(["started", "completed"]);
    expect(compactions.at(-1)?.payload).toMatchObject({
      handoffDirectory,
      handoffPath,
      thresholdRatio: 0.7,
    });
    expect(JSON.stringify(snapshot.entries)).not.toContain("STOP working on the task");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "entry_appended",
        entry: expect.objectContaining({
          kind: "compaction",
          payload: expect.objectContaining({ status: "started" }),
        }),
      }),
    );
    await harness.close();
  });

  test("manual compaction stops after handoff and resumes only with the next user turn", async () => {
    const dataDirectory = await temporaryDirectory();
    const handoffRoot = join(dataDirectory, "tmp");
    const projectDirectory = join(dataDirectory, "project");
    const skillPath = join(projectDirectory, ".agents", "skills", "stable", "SKILL.md");
    await mkdir(join(projectDirectory, ".agents", "skills", "stable"), { recursive: true });
    await writeFile(
      skillPath,
      "---\nname: stable\ndescription: Original stable instructions.\n---\n# Original\n",
    );
    const handoffDirectory = join(handoffRoot, "opengui", "handoffs", "session-1", "run-10");
    const handoffPath = join(handoffDirectory, "HANDOFF.md");
    const model = new FakeModel([
      { text: "Initial work." },
      {
        toolCalls: [
          {
            id: "manual-handoff",
            name: "write",
            input: { path: handoffPath, content: "# Handoff\n\n## Next steps\n1. Resume later.\n" },
          },
        ],
      },
      { text: "Handoff ready." },
      { text: "Resumed on the next user turn." },
    ]);
    const harness = createOpenGuiHarness({
      dataDirectory,
      model,
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
      compaction: { contextWindowTokens: 10_000, tempDirectory: handoffRoot },
    });
    const session = await harness.createSession({
      projectDirectory,
      model: { connectionId: "fake", modelId: "fake-model" },
      reasoning: "none",
    });
    for await (const _event of session.run({ text: "Do some work" })) {
      // drain
    }

    await writeFile(
      skillPath,
      "---\nname: stable\ndescription: Mutated instructions.\n---\n# Mutated\n",
    );

    for await (const _event of session.compact()) {
      // drain
    }
    expect(model.requests).toHaveLength(3);
    expect(model.requests[1]?.systemPrompt).toContain("Original stable instructions.");
    expect(model.requests[1]?.systemPrompt).not.toContain("Mutated instructions.");
    expect(model.requests[2]?.systemPrompt).toContain("Original stable instructions.");
    expect((await session.read()).status).toBe("idle");

    for await (const _event of session.run({ text: "Now continue" })) {
      // drain
    }
    expect(model.requests[3]?.context).toMatchObject([
      {
        type: "user_message",
        text: expect.stringContaining(`Read and inspect the handoff folder at ${handoffDirectory}`),
      },
      { type: "user_message", text: "Now continue" },
    ]);
    await harness.close();
  });

  test("system prompt skills catalog follows the session allowlist and stays locked", async () => {
    const dataDirectory = await temporaryDirectory();
    const homeDirectory = join(dataDirectory, "home");
    const projectDirectory = join(dataDirectory, "project");
    await mkdir(join(projectDirectory, ".agents", "skills", "code-review"), { recursive: true });
    await mkdir(join(homeDirectory, ".agents", "skills", "manual-skill"), { recursive: true });
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(
      join(projectDirectory, ".agents", "skills", "code-review", "SKILL.md"),
      "---\nname: code-review\ndescription: Auto skill.\n---\n",
    );
    await writeFile(
      join(homeDirectory, ".agents", "skills", "manual-skill", "SKILL.md"),
      "---\nname: manual-skill\ndescription: Manual skill.\ndisable-model-invocation: true\n---\n",
    );

    const model = new FakeModel([{ text: "First." }, { text: "Second." }]);
    const harness = createOpenGuiHarness({
      dataDirectory,
      homeDirectory,
      model,
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
    });
    const session = await harness.createSession({
      projectDirectory,
      model: { connectionId: "fake", modelId: "fake-model" },
      reasoning: "none",
    });

    for await (const _event of session.run({
      text: "Use manual",
      skills: ["manual-skill"],
    })) {
      // drain
    }
    expect(model.requests[0]?.systemPrompt).toContain("- manual-skill:");
    expect(model.requests[0]?.systemPrompt).not.toContain("- code-review:");

    await writeFile(
      join(homeDirectory, ".agents", "skills", "manual-skill", "SKILL.md"),
      "---\nname: manual-skill\ndescription: Changed after selection.\ndisable-model-invocation: true\n---\n",
    );

    // Later turns cannot widen the catalog; the first allowlist is locked.
    for await (const _event of session.run({
      text: "Try to enable auto",
      skills: ["code-review", "manual-skill"],
    })) {
      // drain
    }
    expect(model.requests[1]?.systemPrompt).toContain("- manual-skill:");
    expect(model.requests[1]?.systemPrompt).toContain("Manual skill.");
    expect(model.requests[1]?.systemPrompt).not.toContain("Changed after selection.");
    expect(model.requests[1]?.systemPrompt).not.toContain("- code-review:");

    await harness.close();
  });

  test("sends an explicit no-skills system prompt for an empty allowlist", async () => {
    const dataDirectory = await temporaryDirectory();
    const projectDirectory = join(dataDirectory, "project");
    await mkdir(join(projectDirectory, ".agents", "skills", "disabled-skill"), {
      recursive: true,
    });
    await writeFile(
      join(projectDirectory, ".agents", "skills", "disabled-skill", "SKILL.md"),
      "---\nname: disabled-skill\ndescription: Must not be exposed.\n---\n",
    );

    const model = new FakeModel([{ text: "Done." }]);
    const harness = createOpenGuiHarness({
      dataDirectory,
      model,
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
    });
    const session = await harness.createSession({
      projectDirectory,
      model: { connectionId: "fake", modelId: "fake-model" },
      reasoning: "none",
    });

    for await (const _event of session.run({ text: "Run without skills", skills: [] })) {
      // drain
    }

    expect(model.requests[0]?.systemPrompt).toContain(
      "Skills: no skills are enabled for this Session",
    );
    expect(model.requests[0]?.systemPrompt).not.toContain("disabled-skill");
    const snapshot = await session.read();
    expect(snapshot.entries.find((entry) => entry.kind === "user_message")?.payload).toMatchObject({
      skills: [],
    });
    await harness.close();
  });

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

  test("injects images read by the model into the next model turn", async () => {
    const dataDirectory = await temporaryDirectory();
    const projectDirectory = join(dataDirectory, "project");
    await mkdir(projectDirectory);
    const imagePath = join(projectDirectory, "pixel.png");
    await writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const model = new FakeModel([
      { toolCalls: [{ id: "call-image", name: "read", input: { path: imagePath } }] },
      { text: "The image is visible." },
    ]);
    const harness = createOpenGuiHarness({
      dataDirectory,
      model,
      clock: new FakeClock("2026-07-10T10:00:00.000Z"),
      ids: new SequenceIdGenerator(),
    });
    const session = await harness.createSession({
      projectDirectory,
      model: { connectionId: "fake", modelId: "vision-model" },
      reasoning: "none",
    });

    for await (const _event of session.run({ text: "Read pixel.png" })) {
      // drain
    }

    expect(model.requests[1]?.context.at(-1)).toMatchObject({
      type: "tool_result",
      output: {
        content: expect.stringContaining("Read image file [image/png]"),
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            data: expect.any(String),
          },
        ],
      },
    });
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

  test("persists a role-free actor on an immediate user message without changing model context", async () => {
    const dataDirectory = await temporaryDirectory();
    const model = new FakeModel([{ text: "Complete" }]);
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
    const actor = { type: "user" as const, id: "user-1", displayName: "Ada" };

    for await (const _event of session.run({ text: "First", actor })) {
      // Drain the Run.
    }

    const userMessage = (await session.read()).entries.find(
      (entry) => entry.kind === "user_message",
    );
    expect(userMessage?.payload).toMatchObject({ text: "First", actor });
    expect(model.requests[0]?.context.find((item) => item.type === "user_message")).toEqual({
      type: "user_message",
      text: "First",
      model: { connectionId: "fake", modelId: "fake-model" },
      reasoning: "medium",
    });
    await harness.close();
  });

  test("manages pending follow-ups through the Session interface", async () => {
    const dataDirectory = await temporaryDirectory();
    const model = new FakeModel([
      { text: "First complete" },
      { text: "Third edited complete" },
      { text: "Second complete" },
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
    const stream = session
      .run({
        text: "First",
        actor: { type: "user", id: "user-1", displayName: "Ada" },
      })
      [Symbol.asyncIterator]();
    await stream.next();
    await stream.next();

    const second = await session.followUp({
      text: "Second",
      actor: { type: "local", id: "desktop-local", displayName: "Local user" },
    });
    const third = await session.followUp({
      text: "Third",
      actor: { type: "api_key", id: "key-1", displayName: "CI key" },
    });
    const fourth = await session.followUp({ text: "Fourth" });
    await session.updateFollowUp(third.id, {
      text: "Third edited",
      actor: { type: "user", id: "editor", displayName: "Editor" },
    });
    await session.reorderFollowUp(third.id, 0);
    await session.removeFollowUp(fourth.id);

    expect((await session.read()).followUps.map((item) => item.prompt.text)).toEqual([
      "Third edited",
      "Second",
    ]);
    expect((await session.read()).followUps.map((item) => item.prompt.actor)).toEqual([
      { type: "user", id: "editor", displayName: "Editor" },
      { type: "local", id: "desktop-local", displayName: "Local user" },
    ]);
    expect(second.prompt.text).toBe("Second");

    while (!(await stream.next()).done) {
      // Drain the stream through the managed follow-ups.
    }
    expect(
      (await session.read()).entries
        .filter((entry) => entry.kind === "user_message")
        .map((entry) => ({ text: entry.payload.text, actor: entry.payload.actor })),
    ).toEqual([
      {
        text: "First",
        actor: { type: "user", id: "user-1", displayName: "Ada" },
      },
      {
        text: "Third edited",
        actor: { type: "user", id: "editor", displayName: "Editor" },
      },
      {
        text: "Second",
        actor: { type: "local", id: "desktop-local", displayName: "Local user" },
      },
    ]);
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
    expect(
      (await session.read()).entries
        .filter((entry) => entry.kind === "tool_call" || entry.kind === "tool_result")
        .map((entry) => entry.kind),
    ).toEqual(["tool_call", "tool_call", "tool_result", "tool_result"]);
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
            input: { command: `node -e "setTimeout(() => {}, 5000)"`, timeout: 0.05 },
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
    expect(Buffer.byteLength(largeOutput.output)).toBeLessThanOrEqual(5 * 1024);
    expect(
      largeOutput.output.endsWith(
        `The full output has been saved to ${largeOutput.fullOutputPath}.`,
      ),
    ).toBe(true);
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

describe("Session message search", () => {
  test("indexes user and assistant text but excludes reasoning and tool content", async () => {
    const dataDirectory = await temporaryDirectory();
    const projectDirectory = join(dataDirectory, "project");
    await mkdir(projectDirectory);
    const toolPath = join(projectDirectory, "tool-input-marker.txt");
    await writeFile(toolPath, "tool-result-marker");
    const harness = createOpenGuiHarness({
      dataDirectory,
      model: new FakeModel([
        {
          reasoningChunks: ["private-plan-marker"],
          text: "assistant-answer-marker",
          toolCalls: [{ id: "search-test-read", name: "read", input: { path: toolPath } }],
        },
        { text: "Finished." },
      ]),
      ids: new SequenceIdGenerator(),
    });
    const session = await harness.createSession({
      projectDirectory,
      model: { connectionId: "fake", modelId: "fake-model" },
      reasoning: "high",
    });

    for await (const _event of session.run({ text: "user-question-marker" })) {
      // drain
    }

    await expect(
      harness.searchSessionMessages([projectDirectory], "user-question"),
    ).resolves.toEqual([(await session.read()).id]);
    await expect(
      harness.searchSessionMessages([projectDirectory], "assistant-answer"),
    ).resolves.toHaveLength(1);
    await expect(
      harness.searchSessionMessages([projectDirectory], "private-plan-marker"),
    ).resolves.toEqual([]);
    await expect(
      harness.searchSessionMessages([projectDirectory], "tool-input-marker"),
    ).resolves.toEqual([]);
    await expect(
      harness.searchSessionMessages([projectDirectory], "tool-result-marker"),
    ).resolves.toEqual([]);
    await session.delete();
    await expect(
      harness.searchSessionMessages([projectDirectory], "assistant-answer"),
    ).resolves.toEqual([]);
    await harness.close();
  });

  test("searches multiple Project scopes in one FTS query without joining all Sessions", async () => {
    const dataDirectory = await temporaryDirectory();
    const firstProject = join(dataDirectory, "first");
    const secondProject = join(dataDirectory, "second");
    await mkdir(firstProject);
    await mkdir(secondProject);
    const harness = createOpenGuiHarness({
      dataDirectory,
      model: new FakeModel([{ text: "shared-search-marker" }, { text: "shared-search-marker" }]),
      ids: new SequenceIdGenerator(),
    });
    const first = await harness.createSession({
      projectDirectory: firstProject,
      model: { connectionId: "fake", modelId: "fake-model" },
      reasoning: "none",
    });
    const second = await harness.createSession({
      projectDirectory: secondProject,
      model: { connectionId: "fake", modelId: "fake-model" },
      reasoning: "none",
    });
    for await (const _event of first.run({ text: "first" })) {
      // drain
    }
    for await (const _event of second.run({ text: "second" })) {
      // drain
    }

    await expect(harness.searchSessionMessages([firstProject], "shared-search")).resolves.toEqual([
      (await first.read()).id,
    ]);
    await expect(
      harness.searchSessionMessages([firstProject, secondProject], "shared-search"),
    ).resolves.toEqual(expect.arrayContaining([(await first.read()).id, (await second.read()).id]));

    const database = new DatabaseSync(join(dataDirectory, HARNESS_DATABASE_FILENAME), {
      readOnly: true,
    });
    const plan = database
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT DISTINCT session_id
         FROM session_message_search
         WHERE session_message_search MATCH ?`,
      )
      .all('project_scope:"scope00" AND content:"shared"*') as Array<{ detail: string }>;
    database.close();
    expect(plan.map((step) => step.detail).join("\n")).not.toMatch(/SEARCH sessions|ORDER BY/);
    await harness.close();
  });
});
