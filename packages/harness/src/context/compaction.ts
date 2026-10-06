import type { SessionEntry } from "../harness.ts";
import { modelToolResultContent, type ModelContextItem } from "../models/transport.ts";

export const DEFAULT_COMPACTION_THRESHOLD_RATIO = 0.7;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

/** Maximum accepted UTF-8 bytes for one compaction summary response. No silent truncation. */
export const MAX_HANDOFF_BYTES = 64 * 1024;

/** Fixed user-facing message when the validated summary cannot be persisted. */
export const COMPACTION_STORAGE_MESSAGE = "Compaction summary could not be saved";

/** Stable user-facing marker reported when a prompt is blocked on a failed compaction. */
export const COMPACTION_RECOVERY_MESSAGE = "Compaction needs attention before continuing";

/**
 * Where a compaction attempt failed. Classified at the throwing seam (no
 * message-substring heuristics): summary validation, durable persistence,
 * the model/provider transport, or current actor authorization.
 */
export type CompactionFailureSource = "summary" | "storage" | "provider" | "authorization";

/**
 * Typed compaction failure. The message is always sanitized, bounded, and
 * free of filesystem paths, customer content, and provider tokens; any raw
 * diagnostic stays on `cause` in memory and is never serialized into entries.
 */
export class CompactionError extends Error {
  readonly source: CompactionFailureSource;

  constructor(source: CompactionFailureSource, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CompactionError";
    this.source = source;
  }
}

export interface CompactionSummary {
  goal: string;
  currentState: string;
  constraints: string;
  decisions: string;
  blockers: string;
  relevantFiles: string[];
  nextSteps: string[];
}

/**
 * Compaction-only prompt. The model gets NO normal tools in this turn and must
 * return a single structured JSON handoff. Nothing is written to any filesystem:
 * the Harness validates the response and persists it on the completed
 * compaction entry in Harness SQLite.
 */
export function buildHandoffPrompt(): string {
  return `CONTEXT HANDOFF MODE

Your context limit is almost reached. STOP working on the task. Do not continue implementation or answer the user's request in this turn.

Return a single JSON object as your entire response. You have no tools in this turn; do not call any tools. Do not write any files. Do not print prose outside the JSON object (a single \`\`\`json fence around the object is acceptable).

The JSON object must have exactly these fields:
{
  "goal": "the user's goal and constraints",
  "currentState": "completed work and the current state",
  "constraints": "constraints that must be respected going forward",
  "decisions": "key decisions, notes, and learnings",
  "blockers": "work in progress and blockers",
  "relevantFiles": ["exact Project file paths relevant to the task"],
  "nextSteps": ["clear ordered next steps"]
}

Rules:
- goal, currentState, constraints, decisions, and blockers must be strings. Say explicitly when genuinely nothing applies instead of inventing detail.
- relevantFiles and nextSteps must be arrays of strings. relevantFiles may be empty when no files are relevant.
- goal, currentState, and nextSteps must be non-empty.
- Keep the whole JSON response under 64 KiB UTF-8.`;
}

/**
 * Resume context injected Harness-side from the durable summary. The handoff is
 * historical evidence, never a live filesystem location, so resume requires no
 * normal Tool access to any internal directory.
 */
export function buildResumePrompt(handoff: string): string {
  return `HISTORICAL CONTEXT — compacted summary of earlier work in this Session. It is context, not a new user request. Treat file paths and decisions as historical evidence; verify against actual Project files before acting.

${handoff}

Use the summary above to recover task state, then continue the user's work.`;
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string") && value.length <= 500
  );
}

function extractJsonDocument(raw: string): unknown {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return JSON.parse(fence?.[1] ?? trimmed);
}

function toSummary(value: Record<string, unknown>): CompactionSummary {
  const { goal, currentState, constraints, decisions, blockers, relevantFiles, nextSteps } = value;
  if (!isNonEmpty(goal)) throw new Error("Compaction summary was invalid: goal is required");
  if (!isNonEmpty(currentState))
    throw new Error("Compaction summary was invalid: currentState is required");
  if (
    typeof constraints !== "string" ||
    typeof decisions !== "string" ||
    typeof blockers !== "string"
  ) {
    throw new Error(
      "Compaction summary was invalid: constraints, decisions, and blockers are required",
    );
  }
  if (!isStringArray(relevantFiles) || !isStringArray(nextSteps)) {
    throw new Error("Compaction summary was invalid: relevantFiles and nextSteps are required");
  }
  if (nextSteps.every((step) => !step.trim())) {
    throw new Error("Compaction summary was invalid: nextSteps must not be empty");
  }
  return {
    goal: goal.trim(),
    currentState: currentState.trim(),
    constraints: constraints.trim(),
    decisions: decisions.trim(),
    blockers: blockers.trim(),
    relevantFiles: relevantFiles.map((file) => file.trim()).filter((file) => file.length > 0),
    nextSteps: nextSteps.map((step) => step.trim()).filter((step) => step.length > 0),
  };
}

export function renderHandoffMarkdown(summary: CompactionSummary): string {
  const files =
    summary.relevantFiles.length > 0
      ? summary.relevantFiles.map((file) => `- ${file}`).join("\n")
      : "None recorded.";
  return [
    "# Context handoff (compacted summary — historical context, not a new request)",
    "",
    "## Goal",
    summary.goal,
    "",
    "## Current state",
    summary.currentState,
    "",
    "## Constraints",
    summary.constraints || "None recorded.",
    "",
    "## Decisions and learnings",
    summary.decisions || "None recorded.",
    "",
    "## Blockers / work in progress",
    summary.blockers || "None recorded.",
    "",
    "## Relevant files",
    files,
    "",
    "## Next steps",
    summary.nextSteps.map((step, index) => `${index + 1}. ${step}`).join("\n"),
    "",
  ].join("\n");
}

/**
 * Validate one compaction-only model response and render the durable handoff
 * text. Rejects empty, oversized, prose-only, and schema-invalid responses with
 * path-free errors. Never truncates.
 */
export function parseCompactionHandoff(raw: string): string {
  if (!raw.trim()) throw new Error("Compaction summary was empty");
  if (Buffer.byteLength(raw, "utf8") > MAX_HANDOFF_BYTES) {
    throw new Error("Compaction summary exceeds the size limit");
  }
  let document: unknown;
  try {
    document = extractJsonDocument(raw);
  } catch {
    throw new Error("Compaction summary was invalid: expected a single JSON object");
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("Compaction summary was invalid: expected a single JSON object");
  }
  const handoff = renderHandoffMarkdown(toSummary(document as Record<string, unknown>));
  if (Buffer.byteLength(handoff, "utf8") > MAX_HANDOFF_BYTES) {
    throw new Error("Compaction summary exceeds the size limit");
  }
  return handoff;
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

/**
 * Latest terminal compaction outcome wins: a later `completed` clears the
 * block, a later `failed` keeps it. A `started` entry with a later same-run
 * `run_failed` (and no terminal outcome) means recording the failure itself
 * was impossible; it also blocks. Anything else — including a bare `started`
 * or an aborted run — does not block: aborts stay user-intentional.
 */
export function findUnresolvedCompactionFailure(
  entries: readonly SessionEntry[],
): { entry: SessionEntry; index: number } | null {
  const failedRunIds = new Set<string>();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.kind === "compaction") {
      const status = entry.payload.status;
      if (status === "completed") return null;
      if (status === "failed") return { entry, index };
      if (status === "started") {
        const runId = entry.payload.runId;
        if (typeof runId === "string" && failedRunIds.has(runId)) return { entry, index };
      }
      continue;
    }
    if (entry.kind === "run_failed" && typeof entry.payload.runId === "string") {
      failedRunIds.add(entry.payload.runId);
    }
  }
  return null;
}
