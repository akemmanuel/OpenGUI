import { isAbsolute, resolve } from "node:path";
import { atomicWriteFile } from "./atomic-write.ts";

interface WriteToolInput {
  path: string;
  content: string;
  createParents?: boolean;
}

function parseInput(value: unknown): WriteToolInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.path !== "string" || !input.path.trim()) return null;
  if (typeof input.content !== "string") return null;
  if (input.createParents !== undefined && typeof input.createParents !== "boolean") return null;
  return input as unknown as WriteToolInput;
}

export async function executeWriteTool(
  projectDirectory: string,
  rawInput: unknown,
  authorizedPath?: string,
) {
  const input = parseInput(rawInput);
  if (!input) return { error: "write requires path, content, and optional createParents" };
  const path =
    authorizedPath ??
    (isAbsolute(input.path) ? resolve(input.path) : resolve(projectDirectory, input.path));
  try {
    await atomicWriteFile(path, input.content, input.createParents === true);
    return { path, bytesWritten: Buffer.byteLength(input.content, "utf8") };
  } catch (error) {
    return { path, error: error instanceof Error ? error.message : String(error) };
  }
}
