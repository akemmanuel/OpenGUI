import { describe, expect, test } from "vite-plus/test";
import { chatDeltaEvents, shouldRetryChatCompletion, toChatMessages } from "./openai-chat.ts";

describe("chatDeltaEvents", () => {
  test("projects interleaved reasoning_content separately from answer text", () => {
    expect(chatDeltaEvents({ reasoning_content: "Check the factors." })).toEqual([
      { type: "reasoning_delta", delta: "Check the factors." },
    ]);
    expect(chatDeltaEvents({ content: "The answer is 42." })).toEqual([
      { type: "text_delta", delta: "The answer is 42." },
    ]);
  });
});

describe("toChatMessages", () => {
  test("keeps true parallel tool calls on one assistant message", () => {
    expect(
      toChatMessages([
        {
          type: "user_message",
          text: "inspect",
          model: { connectionId: "test", modelId: "test" },
          reasoning: "none",
        },
        { type: "assistant_message", text: "I'll inspect both." },
        { type: "tool_call", toolCallId: "call-1", name: "read", input: { path: "a" } },
        { type: "tool_call", toolCallId: "call-2", name: "read", input: { path: "b" } },
        { type: "tool_result", toolCallId: "call-1", name: "read", output: "a" },
        { type: "tool_result", toolCallId: "call-2", name: "read", output: "b" },
      ]),
    ).toEqual([
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: "I'll inspect both.",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read", arguments: '{"path":"a"}' },
          },
          {
            id: "call-2",
            type: "function",
            function: { name: "read", arguments: '{"path":"b"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "a" },
      { role: "tool", tool_call_id: "call-2", content: "b" },
    ]);
  });

  test("does not rewrite sequential tool rounds into one parallel tool_calls block", () => {
    expect(
      toChatMessages([
        {
          type: "user_message",
          text: "inspect",
          model: { connectionId: "test", modelId: "test" },
          reasoning: "none",
        },
        { type: "tool_call", toolCallId: "call-1", name: "read", input: { path: "a" } },
        { type: "tool_result", toolCallId: "call-1", name: "read", output: "a" },
        { type: "tool_call", toolCallId: "call-2", name: "shell", input: { command: "ls" } },
        { type: "tool_result", toolCallId: "call-2", name: "shell", output: "ok" },
      ]),
    ).toEqual([
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read", arguments: '{"path":"a"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "a" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-2",
            type: "function",
            function: { name: "shell", arguments: '{"command":"ls"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-2", content: "ok" },
    ]);
  });
});

describe("shouldRetryChatCompletion", () => {
  test("retries transient upstream failures even when a gateway reports HTTP 400", () => {
    expect(shouldRetryChatCompletion(400, "Error from provider: Upstream request failed")).toBe(
      true,
    );
    expect(shouldRetryChatCompletion(400, "Invalid tool schema")).toBe(false);
  });
});
