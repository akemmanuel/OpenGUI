import { describe, expect, test } from "vite-plus/test";
import type { HostSessionSnapshot } from "./host-types";
import {
  applyHostTranscriptEvent,
  createHostTranscriptStream,
  projectHostTranscriptStream,
} from "./host-transcript";

function snapshot(): HostSessionSnapshot {
  return {
    id: "session-1",
    projectDirectory: "/project",
    title: "Session",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    status: "running",
    model: { connectionId: "openai", modelId: "gpt-4.1" },
    reasoning: "medium",
    entries: [],
    followUps: [],
  };
}

describe("Host transcript streaming", () => {
  test("shows streamed reasoning and preserves it beside the durable answer", () => {
    let stream = createHostTranscriptStream(snapshot());
    stream = applyHostTranscriptEvent(stream, {
      sessionId: "session-1",
      event: { type: "reasoning_delta", runId: "run-1", delta: "Inspect the file." },
    });
    expect(projectHostTranscriptStream(stream)[0]?.parts[0]).toMatchObject({
      type: "reasoning",
      text: "Inspect the file.",
    });

    stream = applyHostTranscriptEvent(stream, {
      sessionId: "session-1",
      event: {
        type: "entry_appended",
        entry: {
          id: "reasoning-1",
          sessionId: "session-1",
          sequence: 1,
          kind: "assistant_reasoning",
          payload: { runId: "run-1", text: "Inspect the file." },
          createdAt: "2026-07-10T00:00:01.000Z",
        },
      },
    });
    stream = applyHostTranscriptEvent(stream, {
      sessionId: "session-1",
      event: {
        type: "entry_appended",
        entry: {
          id: "answer-1",
          sessionId: "session-1",
          sequence: 2,
          kind: "assistant_message",
          payload: { runId: "run-1", text: "The answer." },
          createdAt: "2026-07-10T00:00:02.000Z",
        },
      },
    });

    expect(projectHostTranscriptStream(stream)[0]?.parts).toMatchObject([
      { type: "reasoning", text: "Inspect the file." },
      { type: "text", text: "The answer." },
    ]);
  });

  test("shows assistant deltas immediately and replaces them with the durable message", () => {
    let stream = createHostTranscriptStream(snapshot());
    stream = applyHostTranscriptEvent(stream, {
      sessionId: "session-1",
      event: { type: "assistant_delta", runId: "run-1", delta: "Hello" },
    });
    stream = applyHostTranscriptEvent(stream, {
      sessionId: "session-1",
      event: { type: "assistant_delta", runId: "run-1", delta: " world" },
    });

    expect(projectHostTranscriptStream(stream)[0]?.parts[0]).toMatchObject({
      type: "text",
      text: "Hello world",
    });

    const durableEvent = {
      sessionId: "session-1",
      event: {
        type: "entry_appended",
        entry: {
          id: "entry-1",
          sessionId: "session-1",
          sequence: 1,
          kind: "assistant_message",
          payload: { runId: "run-1", text: "Hello world" },
          createdAt: "2026-07-10T00:00:01.000Z",
        },
      },
    } as const;
    stream = applyHostTranscriptEvent(stream, durableEvent);
    stream = applyHostTranscriptEvent(stream, durableEvent);

    const messages = projectHostTranscriptStream(stream);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.info.id).toBe("run:run-1");
    expect(messages[0]?.parts[0]).toMatchObject({ type: "text", text: "Hello world" });
  });

  test("groups all reasoning, tool, and answer parts from one run into one assistant message", () => {
    const input = snapshot();
    input.entries = [
      {
        id: "reasoning-1",
        sessionId: input.id,
        sequence: 1,
        kind: "assistant_reasoning",
        payload: { runId: "run-1", text: "I should fetch the weather." },
        createdAt: "2026-07-10T00:00:01.000Z",
      },
      {
        id: "message-1",
        sessionId: input.id,
        sequence: 2,
        kind: "assistant_message",
        payload: { runId: "run-1", text: "Let me fetch that." },
        createdAt: "2026-07-10T00:00:02.000Z",
      },
      {
        id: "call-1",
        sessionId: input.id,
        sequence: 3,
        kind: "tool_call",
        payload: { runId: "run-1", toolCallId: "tool-1", name: "shell", input: {} },
        createdAt: "2026-07-10T00:00:03.000Z",
      },
      {
        id: "result-1",
        sessionId: input.id,
        sequence: 4,
        kind: "tool_result",
        payload: { runId: "run-1", toolCallId: "tool-1", output: { output: "sunny" } },
        createdAt: "2026-07-10T00:00:04.000Z",
      },
      {
        id: "reasoning-2",
        sessionId: input.id,
        sequence: 5,
        kind: "assistant_reasoning",
        payload: { runId: "run-1", text: "Now summarize it." },
        createdAt: "2026-07-10T00:00:05.000Z",
      },
      {
        id: "message-2",
        sessionId: input.id,
        sequence: 6,
        kind: "assistant_message",
        payload: { runId: "run-1", text: "It is sunny." },
        createdAt: "2026-07-10T00:00:06.000Z",
      },
    ];

    const assistantMessages = projectHostTranscriptStream(createHostTranscriptStream(input));
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.info.id).toBe("run:run-1");
    expect(assistantMessages[0]?.parts.map((part) => part.type)).toEqual([
      "reasoning",
      "text",
      "tool",
      "reasoning",
      "text",
    ]);
  });

  test("projects completed shell output and exit status for transcript presentation", () => {
    const input = snapshot();
    input.entries = [
      {
        id: "call-1",
        sessionId: input.id,
        sequence: 1,
        kind: "tool_call",
        payload: {
          runId: "run-1",
          toolCallId: "tool-1",
          name: "shell",
          input: { command: "check" },
        },
        createdAt: "2026-07-10T00:00:01.000Z",
      },
      {
        id: "result-1",
        sessionId: input.id,
        sequence: 2,
        kind: "tool_result",
        payload: {
          runId: "run-1",
          toolCallId: "tool-1",
          name: "shell",
          output: { output: "stdout\nstderr\n", exitCode: 7, signal: null, truncated: false },
        },
        createdAt: "2026-07-10T00:00:02.000Z",
      },
    ];

    const part = projectHostTranscriptStream(createHostTranscriptStream(input))[0]?.parts[0];
    expect(part).toMatchObject({
      type: "tool",
      state: {
        status: "completed",
        output: "stdout\nstderr\n",
        metadata: { exitCode: 7, signal: null, truncated: false },
      },
    });
  });

  test("projects edit diffs as metadata consumed by the transcript renderer", () => {
    const input = snapshot();
    input.entries = [
      {
        id: "call-1",
        sessionId: input.id,
        sequence: 1,
        kind: "tool_call",
        payload: { runId: "run-1", toolCallId: "tool-1", name: "edit", input: { path: "a.txt" } },
        createdAt: "2026-07-10T00:00:01.000Z",
      },
      {
        id: "result-1",
        sessionId: input.id,
        sequence: 2,
        kind: "tool_result",
        payload: {
          runId: "run-1",
          toolCallId: "tool-1",
          name: "edit",
          output: {
            path: "/project/a.txt",
            replacements: 1,
            diff: "--- a.txt\n+++ a.txt\n@@\n-old\n+new\n",
          },
        },
        createdAt: "2026-07-10T00:00:02.000Z",
      },
    ];

    const part = projectHostTranscriptStream(createHostTranscriptStream(input))[0]?.parts[0];
    expect(part).toMatchObject({
      type: "tool",
      state: { status: "completed", metadata: { diff: "--- a.txt\n+++ a.txt\n@@\n-old\n+new\n" } },
    });
  });

  test("projects read file content for expandable transcript presentation", () => {
    const input = snapshot();
    input.entries = [
      {
        id: "call-1",
        sessionId: input.id,
        sequence: 1,
        kind: "tool_call",
        payload: { runId: "run-1", toolCallId: "tool-1", name: "read", input: { path: "a.txt" } },
        createdAt: "2026-07-10T00:00:01.000Z",
      },
      {
        id: "result-1",
        sessionId: input.id,
        sequence: 2,
        kind: "tool_result",
        payload: {
          runId: "run-1",
          toolCallId: "tool-1",
          name: "read",
          output: { path: "/project/a.txt", content: "first\nsecond\n", truncated: false },
        },
        createdAt: "2026-07-10T00:00:02.000Z",
      },
    ];

    const part = projectHostTranscriptStream(createHostTranscriptStream(input))[0]?.parts[0];
    expect(part).toMatchObject({
      type: "tool",
      state: {
        status: "completed",
        output: "first\nsecond\n",
        metadata: { path: "/project/a.txt", truncated: false },
      },
    });
  });

  test("projects written content from the durable tool input", () => {
    const input = snapshot();
    input.entries = [
      {
        id: "call-1",
        sessionId: input.id,
        sequence: 1,
        kind: "tool_call",
        payload: {
          runId: "run-1",
          toolCallId: "tool-1",
          name: "write",
          input: { path: "a.txt", content: "written content\n" },
        },
        createdAt: "2026-07-10T00:00:01.000Z",
      },
      {
        id: "result-1",
        sessionId: input.id,
        sequence: 2,
        kind: "tool_result",
        payload: {
          runId: "run-1",
          toolCallId: "tool-1",
          name: "write",
          output: { path: "/project/a.txt", bytesWritten: 16 },
        },
        createdAt: "2026-07-10T00:00:02.000Z",
      },
    ];

    const part = projectHostTranscriptStream(createHostTranscriptStream(input))[0]?.parts[0];
    expect(part).toMatchObject({
      type: "tool",
      state: {
        status: "completed",
        output: "written content\n",
        metadata: { path: "/project/a.txt", bytesWritten: 16 },
      },
    });
  });
});
