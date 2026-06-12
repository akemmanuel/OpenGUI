import type { QueueMode } from "@/hooks/agent-state-types";

export type PromptIntentDispatch =
  | {
      type: "prompt-now";
      sessionId: string;
      mode: QueueMode;
    }
  | {
      type: "queue-prompt";
      sessionId: string;
      mode: QueueMode;
      insertAt: "front" | "back";
    }
  | { type: "queue-after-part"; sessionId: string; mode: "after-part"; insertAt: "front" };

export function decidePromptIntentDispatch(input: {
  sessionId: string | null;
  requestedMode?: QueueMode;
  busySessionIds: ReadonlySet<string>;
}): PromptIntentDispatch | null {
  if (!input.sessionId) return null;

  const mode = input.requestedMode ?? "queue";
  const busy = input.busySessionIds.has(input.sessionId);
  if (mode === "after-part" && busy) {
    return { type: "queue-after-part", sessionId: input.sessionId, mode, insertAt: "front" };
  }

  if (busy) {
    return {
      type: "queue-prompt",
      sessionId: input.sessionId,
      mode,
      insertAt: mode === "interrupt" ? "front" : "back",
    };
  }

  return {
    type: "prompt-now",
    sessionId: input.sessionId,
    mode,
  };
}
