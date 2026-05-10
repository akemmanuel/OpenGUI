import type { ToolPart } from "@opencode-ai/sdk/v2/client";
import { isRecord } from "./toolTypes";

export interface TaskInfo {
  description: string;
  subagentType?: string;
  /** Child session ID from metadata (for live step tracking). */
  childSessionId?: string;
  /** Subagent tool calls extracted from metadata (if available). */
  toolCalls: Array<{ tool: string; title?: string; status?: string }>;
  /** Final markdown output from the subagent. */
  output: string;
}

function formatDuration(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms));
  if (safeMs < 1000) return `${(safeMs / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(safeMs / 1000);
  if (totalSeconds < 60) {
    if (totalSeconds < 10) return `${(safeMs / 1000).toFixed(1)}s`;
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${String(remMinutes).padStart(2, "0")}m`;
}

export function getTaskDurationLabel(state: ToolPart["state"]): string | null {
  if (
    (state.status === "completed" || state.status === "error") &&
    "time" in state &&
    state.time &&
    typeof state.time.start === "number" &&
    typeof state.time.end === "number"
  ) {
    const duration = state.time.end - state.time.start;
    if (Number.isFinite(duration) && duration >= 0) return formatDuration(duration);
  }
  return null;
}

/** Extract execution info from a task tool call (input for header, output/metadata for content). */
export function extractTaskInfo(state: ToolPart["state"]): TaskInfo | null {
  const input = "input" in state && isRecord(state.input) ? state.input : null;
  const description =
    input && typeof input.description === "string" ? input.description.trim() : "";
  const subagentType =
    input && typeof input.subagent_type === "string" ? input.subagent_type.trim() : undefined;

  let childSessionId: string | undefined;
  const toolCalls: TaskInfo["toolCalls"] = [];
  if ("metadata" in state && isRecord(state.metadata)) {
    if (typeof state.metadata.sessionId === "string") childSessionId = state.metadata.sessionId;
    const rawCalls = state.metadata.toolCalls ?? state.metadata.tools ?? state.metadata.calls;
    if (Array.isArray(rawCalls)) {
      for (const tc of rawCalls) {
        if (isRecord(tc) && typeof tc.tool === "string") {
          toolCalls.push({
            tool: tc.tool,
            title: typeof tc.title === "string" ? tc.title : undefined,
            status: typeof tc.status === "string" ? tc.status : undefined,
          });
        }
      }
    }
  }

  const output = "output" in state && typeof state.output === "string" ? state.output.trim() : "";
  if (!description && !output && toolCalls.length === 0) return null;

  return { description, subagentType, childSessionId, toolCalls, output };
}
