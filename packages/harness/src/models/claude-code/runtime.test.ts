import {
  normalizeContext,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Message,
  type SimpleStreamOptions,
  type Tool,
} from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  fakeClaudeCode,
  type FakeClaudeCodeProcess as Process,
  type FakeClaudeCodeTurn as Turn,
} from "../../test/fake-claude-code.ts";
import { normalizeModelError } from "../transport.ts";
import { CHECKPOINT_OPEN } from "./protocol.ts";
import { claudeCodeModels, createClaudeCodeProvider } from "./provider.ts";
import { ClaudeCodeRuntime, encodeClaudeCodeCredential } from "./runtime.ts";

const model = claudeCodeModels().find((item) => item.id === "claude-opus-5-5")!;
const readTool = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
} as unknown as Tool;

const directories: string[] = [];
const runtimes: ClaudeCodeRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function setup(
  modelTurns: (process: Process, history: unknown[]) => Turn,
  allowLocalLogin = true,
) {
  const fake = fakeClaudeCode(modelTurns);
  const stateDirectory = await mkdtemp(join(tmpdir(), "opengui-claude-code-"));
  directories.push(stateDirectory);
  const runtime = new ClaudeCodeRuntime({
    query: fake.query,
    executable: () => "/bin/claude",
    stateDirectory,
  });
  runtimes.push(runtime);
  const provider = createClaudeCodeProvider({ runtime, allowLocalLogin });
  const send = async (messages: Message[], options: SimpleStreamOptions = {}) => {
    const context: Context = { systemPrompt: "You are OpenGUI.", tools: [readTool], messages };
    const stream = provider.streamSimple(model, normalizeContext(context), {
      apiKey: encodeClaudeCodeCredential({ mode: "local" }),
      sessionId: "session-1",
      ...options,
    });
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) events.push(event);
    return { events, message: await stream.result() };
  };
  return { ...fake, runtime, send };
}

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
/** The assistant turn as OpenGUI stores and replays it: concatenated text plus its calls. */
function replayed(message: AssistantMessage): Message {
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  return {
    ...message,
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...message.content.filter((block) => block.type === "toolCall"),
    ],
  };
}
const toolResult = (id: string, text: string): Message => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 0,
});

describe("Claude Code runtime", () => {
  test("keeps one process across tool calls and follow-up messages", async () => {
    const turns: Turn[] = [
      { text: "Let me look.", calls: [{ id: "toolu_1", name: "read", input: { path: "a.txt" } }] },
      { text: "It says hello." },
      { text: "Still here." },
    ];
    const { send, processes } = await setup(() => turns.shift()!);

    const first = await send([user("What is in a.txt?")]);
    expect(first.message.stopReason).toBe("toolUse");
    expect(first.message.content).toContainEqual({
      type: "toolCall",
      id: "toolu_1",
      name: "read",
      arguments: { path: "a.txt" },
    });
    expect(first.events.map((event) => event.type)).toContain("text_delta");
    expect(first.events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
    expect(first.message.usage).toMatchObject({ input: 10, cacheRead: 5, output: 7 });

    const history = [
      user("What is in a.txt?"),
      replayed(first.message),
      toolResult("toolu_1", "hello"),
    ];
    const second = await send(history);
    expect(second.message.stopReason).toBe("stop");
    expect(second.message.content).toEqual([{ type: "text", text: "It says hello." }]);

    const third = await send([...history, replayed(second.message), user("Are you there?")]);
    expect(third.message.content).toEqual([{ type: "text", text: "Still here." }]);

    expect(processes).toHaveLength(1);
    const [process] = processes;
    expect(process!.prompts).toEqual([
      [{ type: "text", text: "What is in a.txt?" }],
      [{ type: "text", text: "Are you there?" }],
    ]);
    expect(process!.toolResults).toEqual([
      { name: "read", content: [{ type: "text", text: "hello" }] },
    ]);
  });

  test("runs Claude Code isolated, with only OpenGUI's tools and prompt", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-ambient";
    try {
      const { send, processes } = await setup(() => ({ text: "Hi" }));
      await send([user("hi")], { reasoning: "high" });
      const options = processes[0]!.options;
      expect(options).toMatchObject({
        model: "claude-opus-5-5",
        effort: "high",
        systemPrompt: "You are OpenGUI.",
        tools: [],
        allowedTools: ["mcp__og__read"],
        settingSources: [],
        strictMcpConfig: true,
        permissionMode: "dontAsk",
        persistSession: false,
      });
      // The local login must not be overridden by an ambient API key.
      expect(options.env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(options.env?.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
      expect(options.env?.DISABLE_AUTO_COMPACT).toBe("1");
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  test("a token sign-in uses its own config directory", async () => {
    const { send, processes } = await setup(() => ({ text: "Hi" }));
    await send([user("hi")], {
      apiKey: encodeClaudeCodeCredential({ mode: "oauth-token", token: "sk-ant-oat01-x" }),
    });
    const env = processes[0]!.options.env!;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-x");
    expect(env.CLAUDE_CONFIG_DIR).toMatch(/opengui-claude-code-.*config$/u);
  });

  test("changed history starts a fresh process from a checkpoint", async () => {
    const { send, processes } = await setup(() => ({ text: "Answer" }));
    const first = await send([user("one")]);
    await send([user("edited one"), replayed(first.message), user("two")]);
    expect(processes).toHaveLength(2);
    expect(processes[0]!.closed).toBe(true);
    const prompt = processes[1]!.prompts[0] as Array<{ type: string; text?: string }>;
    expect(prompt[0]!.text?.startsWith(CHECKPOINT_OPEN)).toBe(true);
    expect(prompt[0]!.text).toContain("[user]\nedited one");
    expect(prompt.at(-1)).toEqual({ type: "text", text: "two" });
  });

  test("a retried request gets the same answer, not a second one", async () => {
    let calls = 0;
    const { send, processes } = await setup(() => ({ text: `Answer ${++calls}` }));
    const first = await send([user("hi")]);
    const again = await send([user("hi")]);
    expect(again.message.content).toEqual(first.message.content);
    expect(calls).toBe(1);
    expect(processes).toHaveLength(1);
  });

  test("an aborted request stops the process", async () => {
    const { send, processes } = await setup(() => ({ text: "x".repeat(10_000) }));
    const controller = new AbortController();
    controller.abort();
    const aborted = await send([user("hi")], { signal: controller.signal });
    expect(aborted.events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    expect(processes[0]!.closed).toBe(true);
  });

  test("Claude Code failures are classified like any provider's", async () => {
    const { send } = await setup(() => ({ error: "API Error: 401 OAuth token has expired" }));
    const failed = await send([user("hi")]);
    expect(failed.message.stopReason).toBe("error");
    const status = Number(/(?:^|\D)(401)(?:\D|$)/u.exec(failed.message.errorMessage ?? "")?.[1]);
    const error = Object.assign(new Error(failed.message.errorMessage), { status });
    expect(normalizeModelError(error).code).toBe("authentication");
  });

  test("a personal connection cannot use the Host's Claude Code login", async () => {
    const { send, processes } = await setup(() => ({ text: "Hi" }), false);
    const failed = await send([user("hi")]);
    expect(failed.message.errorMessage).toMatch(/401/u);
    expect(processes).toHaveLength(0);
  });
});
