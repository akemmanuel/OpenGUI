import type { MessageEntry } from "@/hooks/agent-state-types";
import type { HostEvent, HostSessionSnapshot } from "@/protocol/host-types";

export interface HostTranscriptStream {
  snapshot: HostSessionSnapshot;
  assistantTextByRun: Readonly<Record<string, string>>;
  reasoningTextByRun: Readonly<Record<string, string>>;
}

export function createHostTranscriptStream(snapshot: HostSessionSnapshot): HostTranscriptStream {
  return { snapshot, assistantTextByRun: {}, reasoningTextByRun: {} };
}

export function applyHostTranscriptEvent(
  stream: HostTranscriptStream,
  hostEvent: HostEvent,
): HostTranscriptStream {
  if (hostEvent.sessionId !== stream.snapshot.id) return stream;
  const event = hostEvent.event;
  if (event.type === "assistant_delta") {
    return {
      ...stream,
      assistantTextByRun: {
        ...stream.assistantTextByRun,
        [event.runId]: `${stream.assistantTextByRun[event.runId] ?? ""}${event.delta}`,
      },
    };
  }
  if (event.type === "reasoning_delta") {
    return {
      ...stream,
      reasoningTextByRun: {
        ...stream.reasoningTextByRun,
        [event.runId]: `${stream.reasoningTextByRun[event.runId] ?? ""}${event.delta}`,
      },
    };
  }
  if (stream.snapshot.entries.some((entry) => entry.id === event.entry.id)) return stream;
  const assistantTextByRun = { ...stream.assistantTextByRun };
  const reasoningTextByRun = { ...stream.reasoningTextByRun };
  if (event.entry.kind === "assistant_message") {
    const runId = text(event.entry.payload.runId);
    if (runId) delete assistantTextByRun[runId];
  }
  if (event.entry.kind === "assistant_reasoning") {
    const runId = text(event.entry.payload.runId);
    if (runId) delete reasoningTextByRun[runId];
  }
  return {
    snapshot: {
      ...stream.snapshot,
      updatedAt: event.entry.createdAt,
      entries: [...stream.snapshot.entries, event.entry].sort(
        (left, right) => left.sequence - right.sequence,
      ),
    },
    assistantTextByRun,
    reasoningTextByRun,
  };
}

export function projectHostTranscriptStream(stream: HostTranscriptStream): MessageEntry[] {
  const messages = projectHostSnapshotToMessages(stream.snapshot);
  const runIds = new Set([
    ...Object.keys(stream.reasoningTextByRun),
    ...Object.keys(stream.assistantTextByRun),
  ]);
  for (const runId of runIds) {
    const streamedText = stream.assistantTextByRun[runId] ?? "";
    const streamedReasoning = stream.reasoningTextByRun[runId] ?? "";
    if (!streamedText && !streamedReasoning) continue;
    const messageId = `stream:${runId}`;
    const now = Date.now();
    messages.push({
      info: {
        id: messageId,
        sessionID: stream.snapshot.id,
        role: "assistant",
        providerID: stream.snapshot.model?.connectionId ?? "",
        modelID: stream.snapshot.model?.modelId ?? "",
        time: { created: now },
      },
      parts: [
        ...(streamedReasoning
          ? [
              {
                id: `${messageId}:reasoning`,
                type: "reasoning" as const,
                text: streamedReasoning,
                sessionID: stream.snapshot.id,
                messageID: messageId,
                tokens: {},
                time: { start: now },
              },
            ]
          : []),
        ...(streamedText
          ? [
              {
                id: `${messageId}:text`,
                type: "text" as const,
                text: streamedText,
                sessionID: stream.snapshot.id,
                messageID: messageId,
                tokens: {},
              },
            ]
          : []),
      ],
    });
  }
  return messages;
}

function createdMs(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

export function projectHostSnapshotToMessages(snapshot: HostSessionSnapshot): MessageEntry[] {
  const messages: MessageEntry[] = [];
  let pendingAssistant: MessageEntry | null = null;

  const flushAssistant = () => {
    if (pendingAssistant) {
      messages.push(pendingAssistant);
      pendingAssistant = null;
    }
  };

  for (const entry of snapshot.entries) {
    if (entry.kind === "user_message") {
      flushAssistant();
      const id = entry.id;
      messages.push({
        info: {
          id,
          sessionID: snapshot.id,
          role: "user",
          providerID: String(
            (entry.payload.model as { connectionId?: string } | undefined)?.connectionId ?? "",
          ),
          modelID: String((entry.payload.model as { modelId?: string } | undefined)?.modelId ?? ""),
          time: { created: createdMs(entry.createdAt) },
        },
        parts: [
          {
            id: `${id}:text`,
            type: "text",
            text: text(entry.payload.text),
            sessionID: snapshot.id,
            messageID: id,
            tokens: {},
          },
        ],
      });
      continue;
    }

    if (entry.kind === "assistant_reasoning") {
      const runId = text(entry.payload.runId, entry.id);
      const messageId = `run:${runId}`;
      if (!pendingAssistant || pendingAssistant.info.id !== messageId) {
        flushAssistant();
        pendingAssistant = {
          info: {
            id: messageId,
            sessionID: snapshot.id,
            role: "assistant",
            providerID: snapshot.model?.connectionId ?? "",
            modelID: snapshot.model?.modelId ?? "",
            time: { created: createdMs(entry.createdAt) },
          },
          parts: [],
        };
      }
      pendingAssistant.parts.push({
        id: entry.id,
        type: "reasoning",
        text: text(entry.payload.text),
        sessionID: snapshot.id,
        messageID: messageId,
        tokens: {},
        time: {
          start: createdMs(entry.createdAt),
          end: createdMs(entry.createdAt),
        },
      });
      continue;
    }

    if (entry.kind === "assistant_message") {
      const runId = text(entry.payload.runId, entry.id);
      const messageId = `run:${runId}`;
      if (!pendingAssistant || pendingAssistant.info.id !== messageId) {
        flushAssistant();
        pendingAssistant = {
          info: {
            id: messageId,
            sessionID: snapshot.id,
            role: "assistant",
            providerID: snapshot.model?.connectionId ?? "",
            modelID: snapshot.model?.modelId ?? "",
            time: { created: createdMs(entry.createdAt) },
          },
          parts: [],
        };
      }
      pendingAssistant.parts.push({
        id: entry.id,
        type: "text",
        text: text(entry.payload.text),
        sessionID: snapshot.id,
        messageID: messageId,
        tokens: {},
      });
      pendingAssistant.info.time.completed = createdMs(entry.createdAt);
      continue;
    }

    if (entry.kind === "tool_call") {
      const messageId = `run:${text(entry.payload.runId, entry.id)}`;
      if (!pendingAssistant || pendingAssistant.info.id !== messageId) {
        flushAssistant();
        pendingAssistant = {
          info: {
            id: messageId,
            sessionID: snapshot.id,
            role: "assistant",
            providerID: snapshot.model?.connectionId ?? "",
            modelID: snapshot.model?.modelId ?? "",
            time: { created: createdMs(entry.createdAt) },
          },
          parts: [],
        };
      }
      pendingAssistant.parts.push({
        id: entry.id,
        type: "tool",
        callID: text(entry.payload.toolCallId, entry.id),
        tool: text(entry.payload.name, "tool"),
        sessionID: snapshot.id,
        messageID: messageId,
        tokens: {},
        state: {
          status: "running",
          input: entry.payload.input,
          time: { start: createdMs(entry.createdAt) },
        },
      });
      continue;
    }

    if (entry.kind === "tool_result" && pendingAssistant) {
      const callId = text(entry.payload.toolCallId);
      pendingAssistant.parts = pendingAssistant.parts.map((part) => {
        if (part.type !== "tool" || part.callID !== callId) return part;
        const output = entry.payload.output;
        const error =
          output && typeof output === "object" && "error" in output
            ? text((output as { error?: unknown }).error)
            : undefined;
        const structuredOutput = output && typeof output === "object" ? output : null;
        const structuredInput =
          part.state.input && typeof part.state.input === "object" ? part.state.input : null;
        const toolOutput =
          part.tool === "shell" && structuredOutput && "output" in structuredOutput
            ? text((structuredOutput as { output?: unknown }).output)
            : part.tool === "read" && structuredOutput && "content" in structuredOutput
              ? text((structuredOutput as { content?: unknown }).content)
              : part.tool === "write" && structuredInput && "content" in structuredInput
                ? text((structuredInput as { content?: unknown }).content)
                : output;
        const metadata =
          structuredOutput && part.tool === "edit" && "diff" in structuredOutput
            ? { diff: (structuredOutput as { diff?: unknown }).diff }
            : structuredOutput && part.tool === "read"
              ? {
                  path: (structuredOutput as { path?: unknown }).path,
                  truncated: (structuredOutput as { truncated?: unknown }).truncated,
                }
              : structuredOutput && part.tool === "write"
                ? {
                    path: (structuredOutput as { path?: unknown }).path,
                    bytesWritten: (structuredOutput as { bytesWritten?: unknown }).bytesWritten,
                  }
                : structuredOutput && part.tool === "shell"
                  ? {
                      exitCode: (structuredOutput as { exitCode?: unknown }).exitCode,
                      signal: (structuredOutput as { signal?: unknown }).signal,
                      truncated: (structuredOutput as { truncated?: unknown }).truncated,
                      timedOut: (structuredOutput as { timedOut?: unknown }).timedOut,
                      aborted: (structuredOutput as { aborted?: unknown }).aborted,
                    }
                  : undefined;
        return {
          ...part,
          state: {
            ...part.state,
            status: error ? "error" : "completed",
            output: toolOutput,
            error,
            metadata,
            time: {
              ...part.state.time,
              end: createdMs(entry.createdAt),
            },
          },
        };
      });
      continue;
    }

    if (entry.kind === "run_failed") {
      const runId = text(entry.payload.runId, entry.id);
      const messageId = `run:${runId}`;
      if (!pendingAssistant || pendingAssistant.info.id !== messageId) {
        flushAssistant();
        pendingAssistant = {
          info: {
            id: messageId,
            sessionID: snapshot.id,
            role: "assistant",
            providerID: snapshot.model?.connectionId ?? "",
            modelID: snapshot.model?.modelId ?? "",
            time: { created: createdMs(entry.createdAt) },
          },
          parts: [],
        };
      }
      pendingAssistant.info.error = {
        name: "Model request failed",
        data: { message: text(entry.payload.error, "Model request failed") },
      };
      pendingAssistant.info.time.completed = createdMs(entry.createdAt);
    }
  }

  flushAssistant();
  return messages;
}
