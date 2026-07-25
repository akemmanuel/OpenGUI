import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const DIRECTORY_READ_NOTE = "Read tool SHOULD only be used for files, but here is the content.";

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
  return (
    typeof input.path === "string" &&
    input.path.trim().length > 0 &&
    (input.startLine === undefined ||
      (typeof input.startLine === "number" && Number.isFinite(input.startLine))) &&
    (input.endLine === undefined ||
      (typeof input.endLine === "number" && Number.isFinite(input.endLine)))
  );
}

export async function executeReadTool(
  projectDirectory: string,
  rawInput: unknown,
  authorizedPath?: string,
): Promise<ReadToolOutput> {
  if (!isReadToolInput(rawInput)) {
    return {
      path: "",
      error: "read requires a non-empty path and optional numeric line range",
      truncated: false,
    };
  }

  const path =
    authorizedPath ??
    (isAbsolute(rawInput.path) ? resolve(rawInput.path) : resolve(projectDirectory, rawInput.path));
  try {
    if ((await stat(path)).isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true });
      const listing = entries
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
        .join("\n");
      return {
        path,
        content: `${listing}${listing ? "\n\n" : ""}${DIRECTORY_READ_NOTE}`,
        truncated: false,
      };
    }

    const bytes = await readFile(path);
    if (bytes.includes(0)) {
      return { path, error: "read does not support binary files", truncated: false };
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { path, error: "read requires valid UTF-8 text", truncated: false };
    }
    const lines = text.split(/(?<=\n)/u);
    const startIndex = Math.max(0, Math.floor(rawInput.startLine ?? 1) - 1);
    const requestedEnd = Math.max(
      startIndex,
      Math.floor(rawInput.endLine ?? Number.MAX_SAFE_INTEGER),
    );
    const selectedText = lines.slice(startIndex, requestedEnd).join("");
    return {
      path,
      content: selectedText,
      truncated: requestedEnd < lines.length,
    };
  } catch (error) {
    return {
      path,
      error: error instanceof Error ? error.message : String(error),
      truncated: false,
    };
  }
}
