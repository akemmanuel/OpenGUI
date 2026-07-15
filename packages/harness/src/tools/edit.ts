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

export async function executeEditTool(projectDirectory: string, rawInput: unknown) {
  const input = parseInput(rawInput);
  if (!input) {
    return { error: "edit requires path, non-empty oldText, newText, and optional replaceAll" };
  }
  const path = isAbsolute(input.path) ? resolve(input.path) : resolve(projectDirectory, input.path);
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
      diff: `--- ${label}\n+++ ${label}\n@@\n${prefixedLines(before, "-")}\n${prefixedLines(after, "+")}\n`,
    };
  } catch (error) {
    return { path, error: error instanceof Error ? error.message : String(error) };
  }
}
