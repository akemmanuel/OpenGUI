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

  test("resolves shared project instructions and only the requesting actor's preferences, including queued turns and restart", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "opengui-scoped-prompt-"));
    temporaryDirectories.push(dataDirectory);
    const project = join(dataDirectory, "project");
    const otherProject = join(dataDirectory, "other");
    await mkdir(project);
    await mkdir(otherProject);
    const alice = { type: "user" as const, id: "alice", displayName: "Alice" };
    const bob = { type: "user" as const, id: "bob", displayName: "Bob" };
    const seen: string[] = [];
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model: ModelTransport = {
      async *stream(request) {
        seen.push(request.systemPrompt);
        if (seen.length === 1) {
          started!();
          await firstRelease;
        }
        yield { type: "text_delta" as const, delta: "Done" };
        yield { type: "completed" as const };
      },
    };
    const host = new OpenGuiHost(dataDirectory, { model });
    await host.start();
    await host.setCustomInstructions("Host rules");
    await host.registerProject(project);
    await host.registerProject(otherProject);
    await host.setProjectInstructions(project, "Shared repo rules");
    await host.setProjectInstructionEditor(project, "frontend", true);
    await host.setPersonalInstructions("Alice preferences", alice);
    await host.setPersonalInstructions("Bob preferences", bob);
    const session = await host.createSession({
      projectDirectory: project,
      model: { connectionId: "fake", modelId: "fake" },
      reasoning: "none",
    });
    await host.prompt(session.id, { text: "Alice turn", actor: alice });
    await firstStarted;
    await host.prompt(session.id, { text: "Bob queued turn", actor: bob });
    release!();
    await host.waitForIdle(session.id);
    expect(seen[0]).toContain("Host rules");
    expect(seen[0]).toContain("Shared repo rules");
    expect(seen[0]).toContain("Alice preferences");
    expect(seen[0]).not.toContain("Bob preferences");
    expect(seen[1]).toContain("Shared repo rules");
    expect(seen[1]).toContain("Bob preferences");
    expect(seen[1]).not.toContain("Alice preferences");
    await host.setProjectInstructions(project, "New shared rules");
    await host.prompt(session.id, { text: "Next turn", actor: bob });
    await host.waitForIdle(session.id);
    expect(seen.at(-1)).toContain("New shared rules");
    expect(seen.at(-1)).not.toContain("Shared repo rules");
    const other = await host.createSession({
      projectDirectory: otherProject,
      model: { connectionId: "fake", modelId: "fake" },
      reasoning: "none",
    });
    await host.prompt(other.id, { text: "Other repo", actor: alice });
    await host.waitForIdle(other.id);
    expect(seen.at(-1)).not.toContain("New shared rules");
    expect(seen.at(-1)).toContain("Alice preferences");
    await host.close();
    const reopened = new OpenGuiHost(dataDirectory, { model });
    await reopened.start();
    expect(reopened.getCustomInstructions()).toBe("Host rules");
    expect(reopened.getPersonalInstructions(alice)).toBe("Alice preferences");
    expect(await reopened.getProjectInstructions(project)).toMatchObject({
      text: "New shared rules",
      teamEditors: { frontend: true },
    });
    await reopened.setProjectInstructions(project, "  ");
    expect((await reopened.getProjectInstructions(project)).text).toBe("");
    expect(reopened.getPersonalInstructions(bob)).toBe("Bob preferences");
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
