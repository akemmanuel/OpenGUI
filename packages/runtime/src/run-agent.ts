import type { HarnessId } from "../../../src/agents/index.ts";
import type { AgentStreamEvent } from "./agent-stream.ts";
import type { OpenGUI } from "./open-gui.ts";
import { isManagedHarnessId } from "./harness-runtime.ts";
import { OpenGuiSdkError } from "./opengui-sdk-error.ts";

export interface RunAgentOptions {
  directory: string;
  harness: HarnessId;
  message: string;
  /** Default 120_000 */
  waitTimeoutMs?: number;
  onStream?: (event: AgentStreamEvent) => void;
}

export interface RunAgentResult {
  sessionId: string;
  harnessId: HarnessId;
  directory: string;
  /** Concatenated `text.delta` from the run, if any. */
  assistantText?: string;
  reason: "idle" | "error" | "timeout";
}

function assistantTextFromDeltas(deltas: string[]): string | undefined {
  const text = deltas.join("").trim();
  return text.length > 0 ? text : undefined;
}

/**
 * One-shot: connect directory, open or create a session, send, wait, return (scripts / CI).
 * Does not use Backend queue (ADR 0005).
 */
export async function runAgent(og: OpenGUI, options: RunAgentOptions): Promise<RunAgentResult> {
  const { directory, harness, message, waitTimeoutMs = 120_000, onStream } = options;
  if (!isManagedHarnessId(harness)) {
    throw new OpenGuiSdkError(
      "UNKNOWN_HARNESS",
      `Harness "${String(harness)}" is not managed by this runtime`,
    );
  }

  const dir = await og.at(directory);
  await dir.connect({ harnesses: [harness] });
  const handle = dir.harness(harness);

  const listed = await handle.sessions.list();
  const session =
    listed.length > 0
      ? await handle.sessions.open(listed[0]!.id)
      : await handle.sessions.create({ title: "run-agent" });

  const textDeltas: string[] = [];
  let runReason: RunAgentResult["reason"] = "idle";

  const off = session.onStream((event) => {
    onStream?.(event);
    if (event.type === "text.delta") textDeltas.push(event.delta);
    if (event.type === "run.end") {
      runReason = event.reason === "error" ? "error" : "idle";
    }
    if (event.type === "error") runReason = "error";
  });

  try {
    await session.send(message, { whileBusy: "wait", waitTimeoutMs });
    try {
      await session.waitUntilIdle({ timeoutMs: waitTimeoutMs });
    } catch (error) {
      if (error instanceof OpenGuiSdkError && error.code === "WAIT_TIMEOUT") {
        return {
          sessionId: session.id,
          harnessId: harness,
          directory: dir.path,
          assistantText: assistantTextFromDeltas(textDeltas),
          reason: "timeout",
        };
      }
      throw error;
    }

    return {
      sessionId: session.id,
      harnessId: harness,
      directory: dir.path,
      assistantText: assistantTextFromDeltas(textDeltas),
      reason: runReason,
    };
  } finally {
    off();
    session.close();
  }
}
