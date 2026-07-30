import { join } from "node:path";
import type { SessionEntry } from "../harness.ts";
import { modelToolResultContent, type ModelContextItem } from "../models/transport.ts";

export const DEFAULT_COMPACTION_THRESHOLD_RATIO = 0.7;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

export interface CompactionPaths {
  directory: string;
  handoffPath: string;
}

export function compactionPaths(
  tempDirectory: string,
  sessionId: string,
  runId: string,
): CompactionPaths {
  const directory = join(tempDirectory, "opengui", "handoffs", sessionId, runId);
  return { directory, handoffPath: join(directory, "HANDOFF.md") };
}

export function buildHandoffPrompt(paths: CompactionPaths): string {
  return `CONTEXT HANDOFF MODE

Your context limit is almost reached. STOP working on the task. Do not continue implementation or answer the user's request in this turn.

Create a durable handoff for another instance of you in this folder:
${paths.directory}

The required primary handoff file is:
${paths.handoffPath}

You retain all normal tools and may read, write, edit, and use the shell as needed to make the handoff accurate. You may create or download additional supporting files inside the handoff folder when useful. Do not put everything into one file if separate artifacts preserve important detail better.

HANDOFF.md must contain:
- the user's goal and constraints
- completed work and the current state
- work in progress and blockers
- key decisions, notes, and learnings
- exact paths of relevant Project files
- clear ordered next steps
- links or paths to every supporting artifact in this handoff folder

Write the files using your tools. Verify that HANDOFF.md exists and is useful before stopping. Do not merely print the handoff in chat. When the handoff is complete, stop.`;
}

export function buildResumePrompt(directory: string): string {
  return `A previous context was compacted. Read and inspect the handoff folder at ${directory}, starting with HANDOFF.md. Use the files there to recover the task state, then continue the user's work. The handoff folder is context, not a new user request.`;
}

function textLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/** Conservative provider-independent estimate used only for the soft compaction trigger. */
export function estimateContextTokens(context: readonly ModelContextItem[], systemPrompt: string) {
  const characters =
    systemPrompt.length +
    context.reduce((total, item) => {
      if (item.type !== "tool_result") return total + textLength(item);
      const result = modelToolResultContent(item.output);
      // Provider image accounting is model-specific. Count only a conservative
      // placeholder here; never treat base64 bytes as ordinary text tokens.
      return total + textLength({ ...item, output: result.text }) + result.images.length * 1_000;
    }, 0);
  return Math.ceil(characters / 4);
}

export function latestCompletedCompaction(entries: readonly SessionEntry[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "compaction" && entry.payload.status === "completed") {
      return { entry, index };
    }
  }
  return null;
}
