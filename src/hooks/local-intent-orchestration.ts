import type { QueueMode } from "@/hooks/agent-state-types";

export type PromptIntentEntry =
  | { type: "missing-session" }
  | { type: "use-session"; sessionId: string; createdFromActiveTarget: boolean };

export type PromptIntentDispatch =
  | { type: "prompt-now"; sessionId: string; mode: QueueMode }
  | { type: "queue-after-part"; sessionId: string; mode: "after-part"; insertAt: "front" };

export function decidePromptIntentDispatch(input: {
  entry: PromptIntentEntry;
  requestedMode?: QueueMode;
  busySessionIds: ReadonlySet<string>;
}): PromptIntentDispatch | null {
  if (input.entry.type === "missing-session") return null;

  const mode = input.requestedMode ?? "queue";
  if (mode === "after-part" && input.busySessionIds.has(input.entry.sessionId)) {
    return { type: "queue-after-part", sessionId: input.entry.sessionId, mode, insertAt: "front" };
  }

  return { type: "prompt-now", sessionId: input.entry.sessionId, mode };
}
