import type { SessionEntry } from "../harness.ts";
import type { ModelContextItem } from "../models/transport.ts";
import { buildResumePrompt, latestCompletedCompaction } from "./compaction.ts";

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

/**
 * Durable handoff text for resume. New completed entries carry validated
 * rendered markdown; older entries already stored prose in the same field.
 * Neither form requires reading any filesystem location.
 */
function resumeHandoffText(entry: SessionEntry): string | null {
  const handoff = entry.payload.handoff;
  if (typeof handoff === "string" && handoff.trim()) return handoff;
  return null;
}

export function buildModelContext(entries: SessionEntry[]): ModelContextItem[] {
  const context: ModelContextItem[] = [];
  const completed = latestCompletedCompaction(entries);
  const handoff = completed ? resumeHandoffText(completed.entry) : null;
  // A corrupt/missing summary cannot authorize dropping any earlier context.
  const compaction = handoff === null ? null : completed;
  const visibleEntries = (compaction ? entries.slice(compaction.index + 1) : entries).filter(
    (entry) => entry.payload.purpose !== "compaction",
  );
  const responsesByRun = new Map<
    string,
    import("../models/transport.ts").ProviderResponseMetadata
  >();
  for (const entry of visibleEntries) {
    if (entry.kind !== "provider_response" || typeof entry.payload.runId !== "string") continue;
    const response = entry.payload.response;
    if (response && typeof response === "object") {
      responsesByRun.set(
        entry.payload.runId,
        response as import("../models/transport.ts").ProviderResponseMetadata,
      );
    }
  }
  if (compaction && handoff !== null) {
    context.push({
      type: "user_message",
      text: buildResumePrompt(handoff),
      model: compaction.entry.payload.model as { connectionId: string; modelId: string },
      reasoning: text(compaction.entry.payload.reasoning, "none"),
    });
  }
  for (const entry of visibleEntries) {
    switch (entry.kind) {
      case "user_message":
        context.push({
          type: "user_message",
          text: text(entry.payload.text),
          model: entry.payload.model as { connectionId: string; modelId: string },
          reasoning: text(entry.payload.reasoning, "none"),
        });
        break;
      case "assistant_message":
        context.push({
          type: "assistant_message",
          text: text(entry.payload.text),
          replay:
            typeof entry.payload.runId === "string"
              ? responsesByRun.get(entry.payload.runId)?.replay
              : undefined,
        });
        break;
      case "tool_call":
        context.push({
          type: "tool_call",
          toolCallId: text(entry.payload.toolCallId),
          name: text(entry.payload.name),
          input: entry.payload.input,
        });
        break;
      case "tool_result":
        context.push({
          type: "tool_result",
          toolCallId: text(entry.payload.toolCallId),
          name: text(entry.payload.name),
          output: entry.payload.output,
        });
        break;
      default:
        break;
    }
  }
  return context;
}
