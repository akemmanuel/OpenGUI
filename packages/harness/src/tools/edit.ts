import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { atomicWriteFile } from "./atomic-write.ts";

interface EditToolInput {
  path: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

function parseInput(value: unknown): EditToolInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.path !== "string" || !input.path.trim()) return null;
  if (typeof input.oldText !== "string" || input.oldText.length === 0) return null;
  if (typeof input.newText !== "string") return null;
  if (input.replaceAll !== undefined && typeof input.replaceAll !== "boolean") return null;
  return input as unknown as EditToolInput;
}

function displayPath(projectDirectory: string, path: string) {
  const projectRelative = relative(projectDirectory, path);
  return projectRelative && !projectRelative.startsWith("..") ? projectRelative : path;
}

function prefixedLines(value: string, prefix: "-" | "+") {
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => `${prefix}${line}`).join("\n");
}

function localizedDiff(before: string, input: EditToolInput, label: string) {
  const ranges = new Map<string, { start: number; end: number }>();
  let match = before.indexOf(input.oldText);
  while (match !== -1) {
    const start = before.lastIndexOf("\n", Math.max(0, match - 1)) + 1;
    const followingNewline = before.indexOf("\n", match + input.oldText.length);
    const end = followingNewline === -1 ? before.length : followingNewline;
    ranges.set(`${start}:${end}`, { start, end });
    if (!input.replaceAll) break;
    match = before.indexOf(input.oldText, match + input.oldText.length);
  }

  const hunks = [...ranges.values()].map(({ start, end }) => {
    const oldSnippet = before.slice(start, end);
    const newSnippet = input.replaceAll
      ? oldSnippet.replaceAll(input.oldText, input.newText)
      : oldSnippet.replace(input.oldText, input.newText);
    return `@@\n${prefixedLines(oldSnippet, "-")}\n${prefixedLines(newSnippet, "+")}`;
  });
  return `--- ${label}\n+++ ${label}\n${hunks.join("\n")}\n`;
}

export async function executeEditTool(
  projectDirectory: string,
  rawInput: unknown,
  authorizedPath?: string,
) {
  const input = parseInput(rawInput);
  if (!input) {
    return { error: "edit requires path, non-empty oldText, newText, and optional replaceAll" };
  }
  const path =
    authorizedPath ??
    (isAbsolute(input.path) ? resolve(input.path) : resolve(projectDirectory, input.path));
  try {
    const before = await readFile(path, "utf8");
    const replacements = before.split(input.oldText).length - 1;
    if (replacements === 0) return { path, error: "The expected source text was not found" };
    if (!input.replaceAll && replacements !== 1) {
      return {
        path,
        error: `The expected source text matched ${replacements} times; make the edit exact or use replaceAll`,
      };
    }
    const after = input.replaceAll
      ? before.replaceAll(input.oldText, input.newText)
      : before.replace(input.oldText, input.newText);
    await atomicWriteFile(path, after, false);
    const label = displayPath(projectDirectory, path).replaceAll("\\", "/");
    return {
      path,
      replacements: input.replaceAll ? replacements : 1,
      diff: localizedDiff(before, input, label),
    };
  } catch (error) {
    return { path, error: error instanceof Error ? error.message : String(error) };
  }
}
