import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createOpenGuiHarness, type SessionEntry } from "./index.ts";
import { FakeClock, FakeModel, type FakeModelTurn, SequenceIdGenerator } from "./test/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function runToolCalls(
  toolCalls: NonNullable<FakeModelTurn["toolCalls"]>,
  setup?: (projectDirectory: string) => Promise<void>,
) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "opengui-tools-contract-"));
  temporaryDirectories.push(dataDirectory);
  const projectDirectory = join(dataDirectory, "project");
  await mkdir(projectDirectory);
  await setup?.(projectDirectory);
  const harness = createOpenGuiHarness({
    dataDirectory,
    model: new FakeModel([{ toolCalls }, { text: "done" }]),
    shell: { executable: process.platform === "win32" ? undefined : "/bin/sh" },
    clock: new FakeClock("2026-07-10T10:00:00.000Z"),
    ids: new SequenceIdGenerator(),
  });
  const session = await harness.createSession({
    projectDirectory,
    model: { connectionId: "fake", modelId: "fake" },
    reasoning: "none",
  });
  for await (const _event of session.run({ text: "exercise tools" })) {
    // Drain the public Run stream.
  }
  const entries = (await session.read()).entries;
  await harness.close();
  return {
    projectDirectory,
    outputs: entries
      .filter((entry): entry is SessionEntry => entry.kind === "tool_result")
      .map((entry) => entry.payload.output as Record<string, unknown>),
  };
}

describe("Harness tool contracts", () => {
  test("read supports inclusive line ranges and reports omitted content", async () => {
    const { outputs } = await runToolCalls(
      [{ id: "read-range", name: "read", input: { path: "notes.txt", startLine: 2, endLine: 3 } }],
      (directory) => writeFile(join(directory, "notes.txt"), "one\ntwo\nthree\nfour\n"),
    );

    expect(outputs[0]).toMatchObject({ content: "two\nthree\n", truncated: true });
  });

  test("read rejects binary files without leaking partial content", async () => {
    const { outputs } = await runToolCalls(
      [{ id: "read-binary", name: "read", input: { path: "binary.dat" } }],
      (directory) => writeFile(join(directory, "binary.dat"), Buffer.from([65, 0, 66])),
    );

    expect(outputs[0]).toMatchObject({
      error: "read does not support binary files",
      truncated: false,
    });
    expect(outputs[0]).not.toHaveProperty("content");
  });

  test("read truncates large UTF-8 text without returning a broken code point", async () => {
    const { outputs } = await runToolCalls(
      [{ id: "read-unicode", name: "read", input: { path: "unicode.txt" } }],
      (directory) => writeFile(join(directory, "unicode.txt"), "🙂".repeat(20_000)),
    );
    const content = outputs[0]?.content as string;

    expect(outputs[0]?.truncated).toBe(true);
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(content).not.toContain("�");
  });

  test("write fails closed on a missing parent unless createParents is requested", async () => {
    const { projectDirectory, outputs } = await runToolCalls([
      { id: "without-parents", name: "write", input: { path: "missing/a.txt", content: "no" } },
      {
        id: "with-parents",
        name: "write",
        input: { path: "created/a.txt", content: "hello 🙂", createParents: true },
      },
    ]);

    expect(outputs[0]?.error).toEqual(expect.any(String));
    await expect(readFile(join(projectDirectory, "missing", "a.txt"))).rejects.toThrow("ENOENT");
    expect(outputs[1]).toMatchObject({ bytesWritten: Buffer.byteLength("hello 🙂") });
    expect(await readFile(join(projectDirectory, "created", "a.txt"), "utf8")).toBe("hello 🙂");
  });

  test("edit refuses ambiguous matches without mutation and replaceAll is explicit", async () => {
    const { projectDirectory, outputs } = await runToolCalls(
      [
        {
          id: "ambiguous",
          name: "edit",
          input: { path: "repeat.txt", oldText: "same", newText: "new" },
        },
        {
          id: "replace-all",
          name: "edit",
          input: { path: "repeat.txt", oldText: "same", newText: "new", replaceAll: true },
        },
      ],
      (directory) => writeFile(join(directory, "repeat.txt"), "same and same\n"),
    );

    expect(outputs[0]?.error).toContain("matched 2 times");
    expect(outputs[1]).toMatchObject({ replacements: 2 });
    expect(await readFile(join(projectDirectory, "repeat.txt"), "utf8")).toBe("new and new\n");
  });

  test("invalid and unknown tool calls become durable results instead of crashing a Run", async () => {
    const { outputs } = await runToolCalls([
      { id: "invalid-write", name: "write", input: { path: "x" } },
      { id: "unknown", name: "not-a-tool", input: {} },
    ]);

    expect(outputs).toEqual([
      { error: "write requires path, content, and optional createParents" },
      { error: "Unknown tool: not-a-tool" },
    ]);
  });

  test.skipIf(process.platform === "win32")(
    "shell runs in the Project and captures both output streams",
    async () => {
      const { outputs } = await runToolCalls([
        {
          id: "shell-context",
          name: "shell",
          input: { command: 'printf "out:%s" "$PWD"; printf "|err" >&2' },
        },
      ]);

      expect(outputs[0]).toMatchObject({ exitCode: 0, timedOut: false, aborted: false });
      expect(outputs[0]?.output).toContain("out:");
      expect(outputs[0]?.output).toContain("|err");
    },
  );
});
