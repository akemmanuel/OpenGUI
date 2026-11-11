import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vite-plus/test";
import { normalizeModelError } from "../transport.ts";
import {
  CHECKPOINT_OPEN,
  CONTINUE_NOTE,
  checkpointContent,
  errorMessage,
  fingerprint,
  MCP_PREFIX,
  mcpBlocks,
  plan,
  toolNameMap,
} from "./protocol.ts";

const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: 0 });
const assistant = (
  text: string,
  calls: Array<{ id: string; name: string; arguments?: Record<string, string> }> = [],
): AssistantMessage => ({
  role: "assistant",
  content: [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...calls.map((call) => ({ type: "toolCall" as const, arguments: {}, ...call })),
  ],
  api: "claude-code",
  provider: "claude-code",
  model: "claude-opus-5-5",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: calls.length ? "toolUse" : "stop",
  timestamp: 0,
});
const result = (id: string, text: string, isError = false): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read",
  content: [{ type: "text", text }],
  isError,
  timestamp: 0,
});

describe("fingerprint", () => {
  test("matches the way OpenGUI rebuilds an assistant turn", () => {
    // Claude streamed two text blocks; OpenGUI stores and replays their concatenation.
    const produced = assistant("", []);
    produced.content = [
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ];
    expect(fingerprint(produced)).toBe(fingerprint(assistant("Hello world")));
  });

  test("knows tool-call turns by their call ids, not their text", () => {
    const call = { id: "toolu_1", name: "read" };
    expect(fingerprint(assistant("Looking", [call]))).toBe(fingerprint(assistant("", [call])));
  });
});

describe("plan", () => {
  const history = [user("hi"), assistant("Let me look", [{ id: "toolu_1", name: "read" }])];
  const records = history.map(fingerprint);
  const response = records.at(-1)!;

  test("continues with the results of held calls and messages that arrived meanwhile", () => {
    const next = plan(
      records,
      response,
      ["toolu_1"],
      [...history, result("toolu_1", "contents"), user("also this")],
    );
    expect(next.kind).toBe("continue");
    if (next.kind !== "continue") return;
    expect(next.results.map((item) => item.toolCallId)).toEqual(["toolu_1"]);
    expect(next.users.map((item) => item.content)).toEqual(["also this"]);
  });

  test("starts fresh when a held call has no result", () => {
    expect(
      plan(records, response, ["toolu_1", "toolu_2"], [...history, result("toolu_1", "x")]),
    ).toEqual({ kind: "fresh" });
  });

  test("retries the same request", () => {
    expect(
      plan(records.slice(0, 1).concat(response), response, ["toolu_1"], history.slice(0, 1)),
    ).toEqual({ kind: "retry" });
  });

  test("starts fresh when history changed", () => {
    expect(plan(records, response, ["toolu_1"], [user("edited"), ...history.slice(1)])).toEqual({
      kind: "fresh",
    });
  });

  test("continues after a final answer with the next user message", () => {
    const done = [user("hi"), assistant("Hello")];
    const next = plan(done.map(fingerprint), fingerprint(done[1]!), [], [...done, user("again")]);
    expect(next).toMatchObject({ kind: "continue", results: [], users: [{ content: "again" }] });
  });
});

describe("checkpointContent", () => {
  test("renders unseen history as a transcript and keeps the trailing user turn", () => {
    const blocks = checkpointContent([
      user("hi"),
      assistant("Looking", [{ id: "toolu_1", name: "read", arguments: { path: "a" } }]),
      {
        ...result("toolu_1", "file text"),
        content: [
          { type: "text", text: "file text" },
          { type: "image", mimeType: "image/png", data: "AAAA" },
        ],
      },
      user("thanks"),
    ]);
    const text = blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    expect(text.startsWith(CHECKPOINT_OPEN)).toBe(true);
    expect(text).toContain('[you called read toolu_1]\n{"path":"a"}');
    expect(text).toContain("[result of read toolu_1]\nfile text");
    expect(blocks).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
    expect(blocks.at(-1)).toEqual({ type: "text", text: "thanks" });
  });

  test("a new conversation is just its user message", () => {
    expect(checkpointContent([user("hi")])).toEqual([{ type: "text", text: "hi" }]);
  });

  test("history ending with a tool result asks Claude to continue", () => {
    const blocks = checkpointContent([
      user("hi"),
      assistant("", [{ id: "toolu_1", name: "read" }]),
      result("toolu_1", "x"),
    ]);
    expect(blocks.at(-1)).toEqual({ type: "text", text: CONTINUE_NOTE });
  });
});

describe("tools", () => {
  test("tool names become valid, unique MCP names and map back", () => {
    const names = toolNameMap([
      { name: "read", description: "", parameters: {} as never },
      { name: "github.search", description: "", parameters: {} as never },
      { name: "github:search", description: "", parameters: {} as never },
      { name: "x".repeat(80), description: "", parameters: {} as never },
    ]);
    expect(names.toClaude.get("read")).toBe("read");
    expect(names.toClaude.get("github.search")).toBe("github_search");
    expect(names.toClaude.get("github:search")).toBe("github_search_2");
    expect((MCP_PREFIX + names.toClaude.get("x".repeat(80))).length).toBeLessThanOrEqual(64);
    for (const [original, claude] of names.toClaude) {
      expect(names.fromClaude.get(claude)).toBe(original);
    }
  });

  test("empty tool output is still a result", () => {
    expect(mcpBlocks([])).toEqual([{ type: "text", text: "(no output)" }]);
  });
});

describe("errorMessage", () => {
  test.each([
    ["API Error: 401 OAuth token has expired", "authentication"],
    ["Not logged in · Please run /login", "authentication"],
    ["You've hit your usage limit · resets 5pm", "rate_limit"],
    ["API Error: 429 rate_limit_error", "rate_limit"],
    ["Prompt is too long: 1000429 tokens > 1000000 maximum", "invalid_request"],
    ["API Error: 529 overloaded_error", "provider_unavailable"],
  ])("%s is classified as %s", (text, code) => {
    const message = errorMessage(text);
    const status = Number(/(?:^|\D)(401|403|408|409|422|429|5\d\d)(?:\D|$)/u.exec(message)?.[1]);
    const error = Object.assign(new Error(message), Number.isFinite(status) ? { status } : {});
    expect(normalizeModelError(error).code).toBe(code);
  });
});
