import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeRuntime, setClaudeCodeRuntime } from "@opengui/harness";
import { fakeClaudeCode, type FakeClaudeCodeTurn } from "@opengui/harness/test";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { OpenGuiHost } from "./opengui-host.ts";

const directories: string[] = [];

afterEach(async () => {
  await setClaudeCodeRuntime(undefined);
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "opengui-claude-code-host-"));
  directories.push(path);
  return path;
}

async function answer(
  host: OpenGuiHost,
  method: "oauth" | "api_key",
  answers: string[],
  actor?: Parameters<OpenGuiHost["beginProviderLogin"]>[2],
) {
  let status = host.beginProviderLogin("claude-code", method, actor);
  const prompts: string[] = [];
  for (const value of answers) {
    for (let tick = 0; tick < 200 && status.state === "running"; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      status = host.providerLoginStatus("claude-code", actor) ?? status;
    }
    expect(status.state).toBe("awaiting_input");
    prompts.push(status.prompt!.type);
    status = await host.respondProviderLogin("claude-code", status.prompt!.id, value, actor);
  }
  for (let tick = 0; tick < 200 && status.state === "running"; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    status = host.providerLoginStatus("claude-code", actor) ?? status;
  }
  return { status, prompts };
}

describe("OpenGuiHost with the Claude Code provider", () => {
  test("signs in with Claude Code's local login and offers its models without pi.dev", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404 }));
    const host = new OpenGuiHost(await directory(), { fetchImpl: fetchImpl as typeof fetch });
    await host.start();
    const provider = host.listProviders().find((item) => item.id === "claude-code");
    expect(provider).toMatchObject({
      name: "Claude Code",
      oauth: { subscription: true },
      apiKey: { interactive: true },
    });

    const { status, prompts } = await answer(host, "oauth", ["local"]);
    expect(prompts).toEqual(["select"]);
    expect(status.state).toBe("succeeded");
    const connection = host.listModelConnections().find((item) => item.id === "claude-code");
    expect(connection?.defaultModelId).toBe("claude-opus-5-5");
    expect(connection?.modelIds).toEqual(
      expect.arrayContaining(["claude-opus-5-5", "claude-sonnet-5-5"]),
    );
    expect(connection?.modelCapabilities?.["claude-opus-5-5"]?.reasoningEfforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(fetchImpl).not.toHaveBeenCalledWith(
      expect.stringContaining("/providers/claude-code"),
      expect.anything(),
    );
    await host.close();
  });

  test("a personal sign-in must bring a token instead of the Host's login", async () => {
    const host = new OpenGuiHost(await directory(), {
      fetchImpl: (async () => new Response("", { status: 404 })) as typeof fetch,
    });
    await host.start();
    const actor = { type: "user" as const, id: "user-1", displayName: "User One" };
    const { status, prompts } = await answer(host, "oauth", ["sk-ant-oat01-personal"], actor);
    expect(prompts).toEqual(["secret"]);
    expect(status.state).toBe("succeeded");
    await host.close();
  });

  test("runs a Session's tool calls through OpenGUI on one warm Claude Code process", async () => {
    const root = await directory();
    const project = join(root, "project");
    await mkdir(project);
    await writeFile(join(project, "a.txt"), "hello from a.txt");
    const turns: FakeClaudeCodeTurn[] = [
      {
        text: "Let me read it.",
        calls: [{ id: "toolu_1", name: "read", input: { path: "a.txt" } }],
      },
      { text: "It says hello." },
      { text: "Still here." },
    ];
    const fake = fakeClaudeCode(() => turns.shift()!);
    await setClaudeCodeRuntime(
      new ClaudeCodeRuntime({
        query: fake.query,
        executable: () => "/bin/claude",
        stateDirectory: join(root, "claude-code"),
      }),
    );
    const host = new OpenGuiHost(root, {
      fetchImpl: (async () => new Response("", { status: 404 })) as typeof fetch,
    });
    await host.start();
    await answer(host, "oauth", ["local"]);
    const session = await host.createSession({
      projectDirectory: project,
      model: { connectionId: "claude-code", modelId: "claude-opus-5-5" },
      reasoning: "high",
    });

    await host.prompt(session.id, { text: "What is in a.txt?" });
    await host.waitForIdle(session.id);
    await host.prompt(session.id, { text: "Are you there?" });
    await host.waitForIdle(session.id);

    const entries = (await host.readSession(session.id)).entries;
    expect(
      entries
        .filter((entry) => entry.kind === "assistant_message")
        .map((entry) => entry.payload.text),
    ).toEqual(["Let me read it.", "It says hello.", "Still here."]);
    expect(entries.some((entry) => entry.kind === "run_failed")).toBe(false);
    // One process saw both user turns as themselves and got the tool result from OpenGUI.
    expect(fake.processes).toHaveLength(1);
    const [claude] = fake.processes;
    expect(claude!.prompts).toEqual([
      [{ type: "text", text: "What is in a.txt?" }],
      [{ type: "text", text: "Are you there?" }],
    ]);
    expect(JSON.stringify(claude!.toolResults)).toContain("hello from a.txt");
    expect(claude!.options).toMatchObject({ model: "claude-opus-5-5", effort: "high", tools: [] });
    expect(claude!.options.allowedTools).toEqual(
      expect.arrayContaining(["mcp__og__read", "mcp__og__shell"]),
    );
    await host.close();
    expect(claude!.closed).toBe(true);
  });
});
