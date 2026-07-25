import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

  test("read lists directory contents with a file-only usage note", async () => {
    const { outputs } = await runToolCalls(
      [{ id: "read-directory", name: "read", input: { path: "." } }],
      async (directory) => {
        await mkdir(join(directory, "nested"));
        await writeFile(join(directory, "notes.txt"), "hello\n");
      },
    );

    expect(outputs[0]).toMatchObject({
      content:
        "nested/\nnotes.txt\n\nRead tool SHOULD only be used for files, but here is the content.",
      truncated: false,
    });
  });

  test("an oversized directory listing preserves both notes", async () => {
    const { outputs } = await runToolCalls(
      [{ id: "read-large-directory", name: "read", input: { path: "." } }],
      async (directory) => {
        await Promise.all(
          Array.from({ length: 150 }, (_, index) =>
            writeFile(
              join(directory, `${String(index).padStart(3, "0")}-${"x".repeat(40)}.txt`),
              "",
            ),
          ),
        );
      },
    );

    expect(outputs[0]?.output).toContain(
      "Read tool SHOULD only be used for files, but here is the content.",
    );
    expect(outputs[0]?.output).toContain("The full tool result has been saved to");
    expect(outputs[0]?.truncated).toBe(true);
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

  test("read rejects malformed UTF-8 instead of returning replacement characters", async () => {
    const { outputs } = await runToolCalls(
      [{ id: "read-invalid-utf8", name: "read", input: { path: "invalid.txt" } }],
      (directory) => writeFile(join(directory, "invalid.txt"), Buffer.from([0x66, 0x80, 0x6f])),
    );

    expect(outputs[0]).toMatchObject({
      error: "read requires valid UTF-8 text",
      truncated: false,
    });
    expect(outputs[0]).not.toHaveProperty("content");
  });

  test("oversized tool results are truncated safely and saved to a temporary file", async () => {
    const original = "🙂".repeat(20_000);
    const { outputs } = await runToolCalls(
      [{ id: "read-unicode", name: "read", input: { path: "unicode.txt" } }],
      (directory) => writeFile(join(directory, "unicode.txt"), original),
    );
    const output = outputs[0]?.output as string;
    const fullOutputPath = outputs[0]?.fullOutputPath as string;

    expect(outputs[0]?.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(outputs[0]), "utf8")).toBeLessThanOrEqual(5 * 1024);
    expect(output).not.toContain("�");
    expect(fullOutputPath).toContain(join(tmpdir(), "opengui-tool-output"));
    expect(JSON.parse(await readFile(fullOutputPath, "utf8"))).toMatchObject({
      content: original,
      truncated: false,
    });
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

  test.skipIf(process.platform === "win32")(
    "atomic replacement preserves an existing file's mode",
    async () => {
      const { projectDirectory } = await runToolCalls(
        [{ id: "replace-script", name: "write", input: { path: "script.sh", content: "new\n" } }],
        async (directory) => {
          const path = join(directory, "script.sh");
          await writeFile(path, "old\n");
          await chmod(path, 0o751);
        },
      );

      expect((await stat(join(projectDirectory, "script.sh"))).mode & 0o777).toBe(0o751);
    },
  );

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

  test.skipIf(process.platform === "win32")(
    "shell truncation keeps returned UTF-8 well formed",
    async () => {
      const { outputs } = await runToolCalls([
        {
          id: "shell-unicode",
          name: "shell",
          input: {
            command: `node -e "process.stdout.write('🙂'.repeat(2000) + 'x')"`,
          },
        },
      ]);

      expect(outputs[0]).toMatchObject({ truncated: true });
      expect(outputs[0]?.output).not.toContain("�");
      expect(Buffer.byteLength(String(outputs[0]?.output), "utf8")).toBeLessThanOrEqual(5 * 1024);
    },
  );
});
