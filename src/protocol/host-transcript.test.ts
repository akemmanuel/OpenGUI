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
  test("projects persisted user-message actors and leaves legacy messages actorless", () => {
    const input = snapshot();
    input.entries = [
      {
        id: "user-1",
        sessionId: input.id,
        sequence: 1,
        kind: "user_message",
        payload: {
          text: "Attributed",
          actor: { type: "user", id: "actor-1", displayName: "alice" },
        },
        createdAt: "2026-07-10T00:00:01.000Z",
      },
      {
        id: "user-2",
        sessionId: input.id,
        sequence: 2,
        kind: "user_message",
        payload: { text: "Legacy" },
        createdAt: "2026-07-10T00:00:02.000Z",
      },
    ];

    const messages = projectHostTranscriptStream(createHostTranscriptStream(input));
    expect(messages[0]?.info.actor).toEqual({
      type: "user",
      id: "actor-1",
      displayName: "alice",
    });
    expect(messages[1]?.info.actor).toBeUndefined();
  });

  test("projects compaction progress without exposing the hidden handoff prompt", () => {
    const input = snapshot();
    input.entries = [
      {
        id: "compact-start",
        sessionId: input.id,
        sequence: 1,
        kind: "compaction",
        payload: { status: "started", handoffDirectory: "/tmp/opengui/handoffs/session-1/run-1" },
        createdAt: "2026-07-10T00:00:01.000Z",
      },
      {
        id: "compact-done",
        sessionId: input.id,
        sequence: 2,
        kind: "compaction",
        payload: { status: "completed", handoffDirectory: "/tmp/opengui/handoffs/session-1/run-1" },
        createdAt: "2026-07-10T00:00:02.000Z",
      },
    ];

    const messages = projectHostTranscriptStream(createHostTranscriptStream(input));
    expect(messages.map((message) => message.parts[0])).toMatchObject([
      { type: "compaction", metadata: { status: "started" } },
      { type: "compaction", metadata: { status: "completed" } },
    ]);
    expect(JSON.stringify(messages)).not.toContain("CONTEXT HANDOFF MODE");
  });

  test("shows streamed reasoning and preserves it beside the durable answer", () => {
    let stream = createHostTranscriptStream(snapshot());
    stream = applyHostTranscriptEvent(stream, {
      sessionId: "session-1",
      event: { type: "reasoning_delta", runId: "run-1", delta: "Inspect the file." },
    });
    const reasoningPart = projectHostTranscriptStream(stream)[0]?.parts[0];
    expect(reasoningPart).toMatchObject({
      type: "reasoning",
      text: "Inspect the file.",
    });
    expect(reasoningPart?.type === "reasoning" && reasoningPart.time.end).toBeUndefined();

    stream = applyHostTranscriptEvent(stream, {
      sessionId: "session-1",
      event: { type: "assistant_delta", runId: "run-1", delta: "The answer" },
    });
    expect(projectHostTranscriptStream(stream)[0]?.parts).toMatchObject([
      { type: "reasoning", text: "Inspect the file.", time: { end: expect.any(Number) } },
      { type: "text", text: "The answer" },
    ]);

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

  test("clears live stream buffers on abort so send-now does not leave ghost assistants", () => {
    let stream = createHostTranscriptStream(snapshot());
    stream = applyHostTranscriptEvent(stream, {
      sessionId: "session-1",
      event: {
        type: "entry_appended",
        entry: {
          id: "user-1",
          sessionId: "session-1",
          sequence: 1,
          kind: "user_message",
          payload: { text: "first", runId: "run-1" },
          createdAt: "2026-07-10T00:00:01.000Z",
        },
      },
    });
    stream = applyHostTranscriptEvent(stream, {
      sessionId: "session-1",
      event: { type: "assistant_delta", runId: "run-1", delta: "partial answer" },
    });
    stream = applyHostTranscriptEvent(stream, {
      sessionId: "session-1",
      event: { type: "reasoning_delta", runId: "run-1", delta: "thinking" },
    });
    expect(projectHostTranscriptStream(stream).map((message) => message.info.id)).toEqual([
      "user-1",
      "stream:run-1",
    ]);

    stream = applyHostTranscriptEvent(stream, {
      sessionId: "session-1",
      event: {
        type: "entry_appended",
        entry: {
          id: "abort-1",
          sessionId: "session-1",
          sequence: 2,
          kind: "run_aborted",
          payload: { runId: "run-1" },
          createdAt: "2026-07-10T00:00:02.000Z",
        },
      },
    });
    stream = applyHostTranscriptEvent(stream, {
      sessionId: "session-1",
      event: {
        type: "entry_appended",
        entry: {
          id: "user-2",
          sessionId: "session-1",
          sequence: 3,
          kind: "user_message",
          payload: { text: "send now please", runId: "run-2" },
          createdAt: "2026-07-10T00:00:03.000Z",
        },
      },
    });
    stream = applyHostTranscriptEvent(stream, {
      sessionId: "session-1",
      event: { type: "assistant_delta", runId: "run-2", delta: "fresh answer" },
    });

    const messages = projectHostTranscriptStream(stream);
    expect(messages.map((message) => message.info.id)).toEqual([
      "user-1",
      "user-2",
      "stream:run-2",
    ]);
    expect(messages.map((message) => message.parts[0])).toMatchObject([
      { type: "text", text: "first" },
      { type: "text", text: "send now please" },
      { type: "text", text: "fresh answer" },
    ]);
    expect(JSON.stringify(messages)).not.toContain("partial answer");
    expect(JSON.stringify(messages)).not.toContain("thinking");
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

  test("keeps a tool-loop assistant active until the Run reaches a terminal entry", () => {
    const input = snapshot();
    input.entries = [
      {
        id: "message-1",
        sessionId: input.id,
        sequence: 1,
        kind: "assistant_message",
        payload: { runId: "run-1", text: "I will inspect that." },
        createdAt: "2026-07-10T00:00:01.000Z",
      },
      {
        id: "call-1",
        sessionId: input.id,
        sequence: 2,
        kind: "tool_call",
        payload: { runId: "run-1", toolCallId: "tool-1", name: "read", input: {} },
        createdAt: "2026-07-10T00:00:02.000Z",
      },
      {
        id: "result-1",
        sessionId: input.id,
        sequence: 3,
        kind: "tool_result",
        payload: { runId: "run-1", toolCallId: "tool-1", output: "done" },
        createdAt: "2026-07-10T00:00:03.000Z",
      },
    ];

    expect(
      projectHostTranscriptStream(createHostTranscriptStream(input))[0]?.info.time.completed,
    ).toBeUndefined();

    input.entries.push({
      id: "completed-1",
      sessionId: input.id,
      sequence: 4,
      kind: "run_completed",
      payload: { runId: "run-1" },
      createdAt: "2026-07-10T00:00:04.000Z",
    });

    expect(
      projectHostTranscriptStream(createHostTranscriptStream(input))[0]?.info.time.completed,
    ).toBe(Date.parse("2026-07-10T00:00:04.000Z"));
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

  test("projects a failed Run as a visible assistant error", () => {
    const input = snapshot();
    input.entries = [
      {
        id: "failed-1",
        sessionId: input.id,
        sequence: 1,
        kind: "run_failed",
        payload: { runId: "run-1", error: "Upstream request failed" },
        createdAt: "2026-07-10T00:00:01.000Z",
      },
    ];

    expect(projectHostTranscriptStream(createHostTranscriptStream(input))[0]).toMatchObject({
      info: {
        role: "assistant",
        error: {
          name: "Model request failed",
          data: { message: "Upstream request failed" },
        },
      },
    });
  });
});
