import type { HostSessionSnapshot } from "./host-types";
import { createHostTranscriptStream, type HostTranscriptStream } from "./host-transcript";

/** A full read may finish after newer SSE entries. Never roll the transcript back. */
export function reconcileHostTranscriptRead(
  snapshot: HostSessionSnapshot,
  live: HostTranscriptStream | null,
  streamAtRead: HostTranscriptStream | null = live,
): HostTranscriptStream {
  if (!live || live.snapshot.id !== snapshot.id) return createHostTranscriptStream(snapshot);
  const sequence = (value: HostSessionSnapshot) => value.entries.at(-1)?.sequence ?? 0;
  const liveIsNewer = sequence(live.snapshot) > sequence(snapshot);
  const entries = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  for (const entry of live.snapshot.entries) entries.set(entry.id, entry);
  const merged = [...entries.values()].sort((a, b) => a.sequence - b.sequence);
  const lifecycle = merged.findLast((entry) =>
    ["run_started", "run_completed", "run_failed", "run_aborted", "run_interrupted"].includes(
      entry.kind,
    ),
  );
  const status =
    liveIsNewer && lifecycle
      ? ({
          run_started: "running",
          run_completed: "idle",
          run_failed: "failed",
          run_aborted: "stopped",
          run_interrupted: "interrupted",
        }[lifecycle.kind] as HostSessionSnapshot["status"])
      : snapshot.status;
  // Durable entries clear buffers only when they are new to the live stream.
  // An earlier assistant_message from the same Run must not erase its next segment.
  const liveEntryIds = new Set(live.snapshot.entries.map((entry) => entry.id));
  const assistantTextByRun = { ...live.assistantTextByRun };
  const reasoningTextByRun = { ...live.reasoningTextByRun };
  const retryByRun = { ...live.retryByRun };
  for (const entry of snapshot.entries) {
    if (liveEntryIds.has(entry.id)) continue;
    const runId = typeof entry.payload.runId === "string" ? entry.payload.runId : "";
    if (
      entry.kind === "assistant_message" &&
      live.assistantTextByRun[runId] === streamAtRead?.assistantTextByRun[runId]
    )
      delete assistantTextByRun[runId];
    if (
      entry.kind === "assistant_reasoning" &&
      live.reasoningTextByRun[runId] === streamAtRead?.reasoningTextByRun[runId]
    )
      delete reasoningTextByRun[runId];
  }
  for (const entry of merged) {
    if (["run_completed", "run_failed", "run_aborted", "run_interrupted"].includes(entry.kind)) {
      const runId = typeof entry.payload.runId === "string" ? entry.payload.runId : "";
      delete assistantTextByRun[runId];
      delete reasoningTextByRun[runId];
      delete retryByRun[runId];
    }
  }
  return {
    snapshot: {
      ...snapshot,
      // Preserve metadata changes delivered after this read's durable boundary.
      ...(live.snapshot.entries.some(
        (entry) => entry.kind === "model_changed" && entry.sequence > sequence(snapshot),
      )
        ? { model: live.snapshot.model }
        : {}),
      ...(live.snapshot.entries.some(
        (entry) => entry.kind === "reasoning_changed" && entry.sequence > sequence(snapshot),
      )
        ? { reasoning: live.snapshot.reasoning }
        : {}),
      updatedAt:
        live.snapshot.updatedAt > snapshot.updatedAt ? live.snapshot.updatedAt : snapshot.updatedAt,
      entries: merged,
      status,
    },
    assistantTextByRun,
    reasoningTextByRun,
    retryByRun,
  };
}
