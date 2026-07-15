import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const MAX_RETURNED_BYTES = 64 * 1024;
const MAX_RETURNED_LINES = 2_000;

export interface ReadToolInput {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface ReadToolOutput {
  path: string;
  content?: string;
  error?: string;
  truncated: boolean;
}

function isReadToolInput(value: unknown): value is ReadToolInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return typeof input.path === "string" && input.path.trim().length > 0;
}

export async function executeReadTool(
  projectDirectory: string,
  rawInput: unknown,
): Promise<ReadToolOutput> {
  if (!isReadToolInput(rawInput)) {
    return { path: "", error: "read requires a non-empty path", truncated: false };
  }

  const path = isAbsolute(rawInput.path)
    ? resolve(rawInput.path)
    : resolve(projectDirectory, rawInput.path);
  try {
    const bytes = await readFile(path);
    if (bytes.includes(0)) {
      return { path, error: "read does not support binary files", truncated: false };
    }

    const text = bytes.toString("utf8");
    const lines = text.split(/(?<=\n)/u);
    const startIndex = Math.max(0, Math.floor(rawInput.startLine ?? 1) - 1);
    const requestedEnd = Math.max(
      startIndex,
      Math.floor(rawInput.endLine ?? Number.MAX_SAFE_INTEGER),
    );
    const selected = lines.slice(
      startIndex,
      Math.min(requestedEnd, startIndex + MAX_RETURNED_LINES),
    );
    const selectedText = selected.join("");
    const returned = Buffer.from(selectedText).subarray(0, MAX_RETURNED_BYTES).toString("utf8");
    return {
      path,
      content: returned,
      truncated:
        returned.length < selectedText.length ||
        requestedEnd < lines.length ||
        startIndex + MAX_RETURNED_LINES < Math.min(requestedEnd, lines.length),
    };
  } catch (error) {
    return {
      path,
      error: error instanceof Error ? error.message : String(error),
      truncated: false,
    };
  }
}
