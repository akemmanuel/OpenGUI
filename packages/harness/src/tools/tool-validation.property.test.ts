import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { seeded } from "../test/seeded.ts";
import { executeTool } from "./execute-tool.ts";
import { TOOL_DEFINITIONS } from "./tool-definitions.ts";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true }))));

describe("seeded tool argument validation", () => {
  test("describes the optional shell timeout in seconds with its default and maximum", () => {
    const shell = TOOL_DEFINITIONS.find((tool) => tool.name === "shell");

    expect(shell?.parameters.properties.timeout).toEqual({
      type: "number",
      description: "Timeout in seconds (default 30, maximum 5000).",
      default: 30,
      exclusiveMinimum: 0,
      maximum: 5_000,
    });
    expect(shell?.parameters.required).toEqual(["command"]);
  });

  test("500 malformed calls fail as values and never throw, authorize a path, or execute a command", async () => {
    const projectDirectory = await mkdtemp(join(tmpdir(), "opengui-tool-validation-"));
    cleanup.push(projectDirectory);
    let authorizations = 0;
    const context = {
      projectDirectory,
      dataDirectory: projectDirectory,
      sessionId: "session",
      toolCallId: "call",
      shell: { family: "posix" as const, executable: "/bin/sh" },
      signal: new AbortController().signal,
      executionPolicy: {
        revision: 7,
        restricted: false,
        shellAllowed: true,
        async authorizePath() {
          authorizations += 1;
          return { allowed: true, canonicalPath: join(projectDirectory, "never") };
        },
      },
    };
    const random = seeded(0x544f4f4c);
    const invalid = [null, undefined, false, 1, "path", [], {}, { path: "" }, { path: 4 }];
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const name = random.pick(["read", "write", "edit", "shell", "unknown"]);
      const input = random.pick(invalid);
      const output = await executeTool(context, name, input);
      expect(output, `${iteration}: ${name}`).toHaveProperty("error");
    }
    expect(authorizations).toBe(0);
  });

  test("rejects wrong optional types and non-finite shell timeouts", async () => {
    const projectDirectory = await mkdtemp(join(tmpdir(), "opengui-tool-options-"));
    cleanup.push(projectDirectory);
    const context = {
      projectDirectory,
      dataDirectory: projectDirectory,
      sessionId: "session",
      toolCallId: "call",
      shell: { family: "posix" as const, executable: "/bin/sh" },
      signal: new AbortController().signal,
      executionPolicy: {
        revision: 1,
        restricted: false,
        shellAllowed: true,
        async authorizePath(path: string) {
          return { allowed: true, canonicalPath: path };
        },
      },
    };
    await expect(
      executeTool(context, "read", { path: "x", startLine: "2" }),
    ).resolves.toMatchObject({
      error: "read requires a non-empty path and optional numeric line range",
    });
    await expect(
      executeTool(context, "shell", { command: "printf should-not-run", timeout: Number.NaN }),
    ).resolves.toEqual({
      error: "shell requires a non-empty command and optional timeout in seconds",
    });
  });
});
