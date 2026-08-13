import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { ModelTransport } from "@opengui/harness";
import { OpenGuiHost } from "./opengui-host.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("OpenGUI Host custom instructions", () => {
  test("persists host-wide instructions and includes them on the next model turn", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "opengui-host-instructions-"));
    temporaryDirectories.push(dataDirectory);
    const project = join(dataDirectory, "project");
    await mkdir(project);
    const seen: string[] = [];
    const model: ModelTransport = {
      async *stream(request) {
        seen.push(request.systemPrompt);
        yield { type: "text_delta" as const, delta: "Done" };
        yield { type: "completed" as const };
      },
    };
    const host = new OpenGuiHost(dataDirectory, { model });
    await host.start();

    expect(host.getCustomInstructions()).toBe("");
    await host.setCustomInstructions("Always reply in Spanish.");
    expect(host.getCustomInstructions()).toBe("Always reply in Spanish.");

    const session = await host.createSession({
      projectDirectory: project,
      model: { connectionId: "fake", modelId: "fake" },
      reasoning: "none",
    });
    await host.prompt(session.id, { text: "Hello" });
    await host.waitForIdle(session.id);
    expect(seen.at(-1)).toContain("Always reply in Spanish.");
    await host.close();

    const reopened = new OpenGuiHost(dataDirectory, { model });
    await reopened.start();
    expect(reopened.getCustomInstructions()).toBe("Always reply in Spanish.");
    await reopened.setCustomInstructions("   \n");
    expect(reopened.getCustomInstructions()).toBe("");
    await reopened.close();
  });

  test("rejects instructions that exceed the host limit", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "opengui-host-instructions-limit-"));
    temporaryDirectories.push(dataDirectory);
    const host = new OpenGuiHost(dataDirectory);
    await host.start();
    await expect(host.setCustomInstructions("x".repeat(32_001))).rejects.toThrow(
      "Custom instructions must be at most 32000 characters",
    );
    expect(host.getCustomInstructions()).toBe("");
    await host.close();
  });
});
