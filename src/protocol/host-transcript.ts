import type { MessageEntry } from "@/hooks/agent-state-types";
import type { HostEvent, HostSessionSnapshot } from "@/protocol/host-types";
import type { TranscriptAttachment } from "@/protocol/session-transcript";

export interface HostModelRetry {
  attempt: number;
  maxAttempts: number;
  code: string;
}

export interface HostTranscriptStream {
  snapshot: HostSessionSnapshot;
  assistantTextByRun: Readonly<Record<string, string>>;
  reasoningTextByRun: Readonly<Record<string, string>>;
  /** Pending automatic model retry per run; cleared by the next output or entry. */
  retryByRun?: Readonly<Record<string, HostModelRetry>>;
}

/** Host files a tool asked the transcript to show, such as generated images. */
function previewImageAttachments(output: object | null): TranscriptAttachment[] {
  const previews = output && (output as { previewImages?: unknown }).previewImages;
  if (!Array.isArray(previews)) return [];
  return previews.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const { path, mimeType } = item as { path?: unknown; mimeType?: unknown };
    if (typeof path !== "string" || !path) return [];
    return [
      {
        url: path,
        mime: typeof mimeType === "string" ? mimeType : "image/png",
        filename: path.split(/[\\/]/u).at(-1),
      },
    ];
  });
}

/** Web pages a search tool reported, limited to http(s) links. */
function webSources(output: object | null) {
  const sources = output && (output as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return undefined;
  return sources.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const { title, url } = item as { title?: unknown; url?: unknown };
    if (typeof url !== "string" || !/^https?:\/\//iu.test(url)) return [];
    return [{ title: typeof title === "string" && title ? title : url, url }];
  });
}

export function createHostTranscriptStream(snapshot: HostSessionSnapshot): HostTranscriptStream {
  return { snapshot, assistantTextByRun: {}, reasoningTextByRun: {} };
}

const TERMINAL_RUN_ENTRY_KINDS = new Set([
  "run_completed",
  "run_aborted",
  "run_failed",
  "run_interrupted",
]);

/**
 * Replaces the snapshot after a reload of the same Session but keeps live text
 * for Runs the snapshot has not finished. Send-now reloads while the new Run
 * is already streaming; starting from an empty stream dropped its first text.
 */
export function rehydrateHostTranscriptStream(
  snapshot: HostSessionSnapshot,
  previous: HostTranscriptStream | null,
): HostTranscriptStream {
  const fresh = createHostTranscriptStream(snapshot);
  if (!previous || previous.snapshot.id !== snapshot.id) return fresh;
  const finishedText = new Set<string>();
  const finishedReasoning = new Set<string>();
  for (const entry of snapshot.entries) {
    const runId = text(entry.payload.runId);
    if (!runId) continue;
    const terminal = TERMINAL_RUN_ENTRY_KINDS.has(entry.kind);
    if (terminal || entry.kind === "assistant_message") finishedText.add(runId);
    if (terminal || entry.kind === "assistant_reasoning") finishedReasoning.add(runId);
  }
  const keep = (buffers: Readonly<Record<string, string>>, finished: Set<string>) =>
    Object.fromEntries(Object.entries(buffers).filter(([runId]) => !finished.has(runId)));
  return {
    ...fresh,
    assistantTextByRun: keep(previous.assistantTextByRun, finishedText),
    reasoningTextByRun: keep(previous.reasoningTextByRun, finishedReasoning),
  };
}

function withoutRetry(stream: HostTranscriptStream, runId: string | undefined) {
  if (!runId || !stream.retryByRun?.[runId]) return stream.retryByRun;
  const { [runId]: _cleared, ...rest } = stream.retryByRun;
  return rest;
}

export function applyHostTranscriptEvent(
  stream: HostTranscriptStream,
  hostEvent: HostEvent,
): HostTranscriptStream {
  if (hostEvent.sessionId !== stream.snapshot.id) return stream;
  const event = hostEvent.event;
  if (event.type === "model_retry") {
    return {
      ...stream,
      retryByRun: {
        ...stream.retryByRun,
        [event.runId]: {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          code: event.code,
        },
      },
    };
  }
  if (event.type === "assistant_delta") {
    return {
      ...stream,
      retryByRun: withoutRetry(stream, event.runId),
      assistantTextByRun: {
        ...stream.assistantTextByRun,
        [event.runId]: `${stream.assistantTextByRun[event.runId] ?? ""}${event.delta}`,
      },
    };
  }
  if (event.type === "reasoning_delta") {
    return {
      ...stream,
      retryByRun: withoutRetry(stream, event.runId),
      reasoningTextByRun: {
        ...stream.reasoningTextByRun,
        [event.runId]: `${stream.reasoningTextByRun[event.runId] ?? ""}${event.delta}`,
      },
    };
  }
  // Ignore event types from a newer Host instead of failing the whole stream.
  if (event.type !== "entry_appended" || !event.entry) return stream;
  if (stream.snapshot.entries.some((entry) => entry.id === event.entry.id)) return stream;
  let nextModel = stream.snapshot.model;
  if (event.entry.kind === "model_changed") {
    const model = event.entry.payload.model as
      | { connectionId?: unknown; modelId?: unknown }
      | undefined;
    if (typeof model?.connectionId === "string" && typeof model?.modelId === "string") {
      nextModel = { connectionId: model.connectionId, modelId: model.modelId };
    }
  }
  let nextReasoning = stream.snapshot.reasoning;
  if (event.entry.kind === "reasoning_changed") {
    const reasoning = event.entry.payload.reasoning;
    if (typeof reasoning === "string") {
      nextReasoning = reasoning as typeof nextReasoning;
    }
  }
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
  // Terminal run markers must drop live buffers. Otherwise abort/send-now leaves
  // ghost stream:* assistant rows that corrupt message history after the next turn.
  if (
    event.entry.kind === "run_completed" ||
    event.entry.kind === "run_aborted" ||
    event.entry.kind === "run_failed" ||
    event.entry.kind === "run_interrupted"
  ) {
    const runId = text(event.entry.payload.runId);
    if (runId) {
      delete assistantTextByRun[runId];
      delete reasoningTextByRun[runId];
    }
  }
  return {
    snapshot: {
      ...stream.snapshot,
      model: nextModel,
      reasoning: nextReasoning,
      updatedAt: event.entry.createdAt,
      entries: [...stream.snapshot.entries, event.entry].sort(
        (left, right) => left.sequence - right.sequence,
      ),
    },
    assistantTextByRun,
    reasoningTextByRun,
    retryByRun: withoutRetry(stream, text(event.entry.payload.runId) || undefined),
  };
}

export function projectHostTranscriptStream(stream: HostTranscriptStream): MessageEntry[] {
  const messages = projectHostSnapshotToMessages(stream.snapshot);
  const runIds = new Set([
    ...Object.keys(stream.reasoningTextByRun),
    ...Object.keys(stream.assistantTextByRun),
    ...Object.keys(stream.retryByRun ?? {}),
  ]);
  for (const runId of runIds) {
    const streamedText = stream.assistantTextByRun[runId] ?? "";
    const streamedReasoning = stream.reasoningTextByRun[runId] ?? "";
    const retry = stream.retryByRun?.[runId];
    if (!streamedText && !streamedReasoning && !retry) continue;
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
        ...(retry
          ? [
              {
                id: `${messageId}:retry`,
                type: "retry" as const,
                sessionID: stream.snapshot.id,
                messageID: messageId,
                tokens: {},
                metadata: { ...retry },
              },
            ]
          : []),
        ...(streamedReasoning
          ? [
              {
                id: `${messageId}:reasoning`,
                type: "reasoning" as const,
                text: streamedReasoning,
                sessionID: stream.snapshot.id,
                messageID: messageId,
                tokens: {},
                time: streamedText ? { start: now, end: now } : { start: now },
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

  const responseByRun = new Map<string, { providerID: string; modelID: string }>();
  for (const entry of snapshot.entries) {
    if (entry.kind !== "provider_response") continue;
    const runId = typeof entry.payload.runId === "string" ? entry.payload.runId : "";
    const response =
      entry.payload.response && typeof entry.payload.response === "object"
        ? (entry.payload.response as { provider?: unknown; model?: unknown })
        : null;
    const providerID = typeof response?.provider === "string" ? response.provider : "";
    const modelID = typeof response?.model === "string" ? response.model : "";
    if (runId && (providerID || modelID)) responseByRun.set(runId, { providerID, modelID });
  }

  const assistantAttribution = (runId: string) => {
    const attributed = responseByRun.get(runId);
    if (attributed) return attributed;
    return {
      providerID: snapshot.model?.connectionId ?? "",
      modelID: snapshot.model?.modelId ?? "",
    };
  };

  const flushAssistant = () => {
    if (pendingAssistant) {
      messages.push(pendingAssistant);
      pendingAssistant = null;
    }
  };

  // A compaction run settles into one stable row: once a started entry has a
  // later terminal (completed/failed) entry for the same run, only the
  // terminal projects. Distinct runs and legacy entries without a runId stay
  // independent rows.
  const compactionTerminalByRun = new Map<string, (typeof snapshot.entries)[number]>();
  for (const entry of snapshot.entries) {
    if (
      entry.kind === "compaction" &&
      (entry.payload.status === "completed" || entry.payload.status === "failed") &&
      typeof entry.payload.runId === "string"
    ) {
      compactionTerminalByRun.set(entry.payload.runId, entry);
    }
  }

  for (const entry of snapshot.entries) {
    if (entry.kind === "user_message") {
      flushAssistant();
      const id = entry.id;
      messages.push({
        info: {
          id,
          sessionID: snapshot.id,
          role: "user",
          actor: entry.payload.actor,
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

    if (entry.kind === "compaction") {
      flushAssistant();
      const id = entry.id;
      const runId = typeof entry.payload.runId === "string" ? entry.payload.runId : undefined;
      const terminal = runId ? compactionTerminalByRun.get(runId) : undefined;
      if (entry.payload.status === "started" && terminal && terminal.id !== entry.id) {
        continue;
      }
      messages.push({
        info: {
          id,
          sessionID: snapshot.id,
          role: "assistant",
          providerID: snapshot.model?.connectionId ?? "",
          modelID: snapshot.model?.modelId ?? "",
          time: {
            created: createdMs(entry.createdAt),
            completed:
              entry.payload.status === "completed" || entry.payload.status === "failed"
                ? createdMs(entry.createdAt)
                : undefined,
          },
        },
        parts: [
          {
            id: `${id}:compaction`,
            type: "compaction",
            sessionID: snapshot.id,
            messageID: id,
            tokens: {},
            metadata: {
              status: text(entry.payload.status, "started"),
              reason: text(entry.payload.reason, "threshold"),
              handoffDirectory: text(entry.payload.handoffDirectory),
            },
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
        const attribution = assistantAttribution(runId);
        pendingAssistant = {
          info: {
            id: messageId,
            sessionID: snapshot.id,
            role: "assistant",
            providerID: attribution.providerID,
            modelID: attribution.modelID,
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
        const attribution = assistantAttribution(runId);
        pendingAssistant = {
          info: {
            id: messageId,
            sessionID: snapshot.id,
            role: "assistant",
            providerID: attribution.providerID,
            modelID: attribution.modelID,
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
      continue;
    }

    if (
      entry.kind === "run_completed" ||
      entry.kind === "run_aborted" ||
      entry.kind === "run_interrupted"
    ) {
      const runId = text(entry.payload.runId, entry.id);
      const messageId = `run:${runId}`;
      if (pendingAssistant?.info.id === messageId) {
        pendingAssistant.info.time.completed = createdMs(entry.createdAt);
      }
      continue;
    }

    if (entry.kind === "tool_call") {
      const runId = text(entry.payload.runId, entry.id);
      const messageId = `run:${runId}`;
      if (!pendingAssistant || pendingAssistant.info.id !== messageId) {
        flushAssistant();
        const attribution = assistantAttribution(runId);
        pendingAssistant = {
          info: {
            id: messageId,
            sessionID: snapshot.id,
            role: "assistant",
            providerID: attribution.providerID,
            modelID: attribution.modelID,
            time: { created: createdMs(entry.createdAt) },
          },
          parts: [],
        };
      }
      pendingAssistant.parts.push({
        id: entry.id,
        type: "tool",
        callID: text(entry.payload.toolCallId, entry.id),
        tool: text(entry.payload.displayName, text(entry.payload.name, "tool")),
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
            : output &&
                typeof output === "object" &&
                (output as { status?: unknown }).status === "error"
              ? text((output as { summary?: unknown }).summary, "Tool returned an error")
              : undefined;
        const structuredOutput = output && typeof output === "object" ? output : null;
        const structuredInput =
          part.state.input && typeof part.state.input === "object" ? part.state.input : null;
        const structuredSummary =
          structuredOutput && "summary" in structuredOutput
            ? text((structuredOutput as { summary?: unknown }).summary)
            : "";
        const toolOutput = structuredSummary
          ? structuredSummary
          : part.tool === "shell" && structuredOutput && "output" in structuredOutput
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
                      // Machine reason for classified shell failures
                      // (policy denials and sandbox broker faults). The tool
                      // view maps known reasons to localized messages.
                      reason: (structuredOutput as { reason?: unknown }).reason,
                    }
                  : undefined;
        const attachments = previewImageAttachments(structuredOutput);
        const sources = webSources(structuredOutput);
        return {
          ...part,
          state: {
            ...part.state,
            status: error ? "error" : "completed",
            output: toolOutput,
            error,
            metadata: sources ? { ...metadata, sources } : metadata,
            ...(attachments.length ? { attachments } : {}),
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
        const attribution = assistantAttribution(runId);
        pendingAssistant = {
          info: {
            id: messageId,
            sessionID: snapshot.id,
            role: "assistant",
            providerID: attribution.providerID,
            modelID: attribution.modelID,
            time: { created: createdMs(entry.createdAt) },
          },
          parts: [],
        };
      }
      const providerDetail = text(entry.payload.error);
      const normalizedError =
        entry.payload.normalizedError && typeof entry.payload.normalizedError === "object"
          ? (entry.payload.normalizedError as Record<string, unknown>)
          : undefined;
      const summary = text(normalizedError?.message);
      const detail = text(normalizedError?.detail, providerDetail);
      const message =
        summary && detail && summary !== detail
          ? `${summary}: ${detail}`
          : summary || detail || "Model request failed";
      pendingAssistant.info.error = {
        name: "Model request failed",
        data: {
          message,
          ...(entry.payload.recoveryRequired === true
            ? { code: "compactionRecoveryRequired" }
            : {}),
          ...(text(normalizedError?.code) ? { providerCode: text(normalizedError?.code) } : {}),
          failedAt: createdMs(entry.createdAt),
        },
      };
      pendingAssistant.info.time.completed = createdMs(entry.createdAt);
    }
  }

  flushAssistant();
  return messages;
}
