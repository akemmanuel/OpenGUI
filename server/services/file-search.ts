import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist"]);

export interface FindFilesOptions {
  maxResults?: number;
}

export async function findFilesInDirectory(
  directory: string | null | undefined,
  query: string | null | undefined,
  options: FindFilesOptions = {},
): Promise<string[]> {
  const root = directory?.trim();
  const needle = query?.trim().toLowerCase();
  if (!root || !needle) return [];

  const rootDir = root;
  const needleText = needle;
  const results: string[] = [];
  const maxResults = options.maxResults ?? 200;

  async function visit(currentDirectory: string) {
    if (results.length >= maxResults) return;

    let entries;
    try {
      entries = await readdir(currentDirectory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxResults) return;
      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;

      const absolutePath = join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }

      const relativePath = relative(rootDir, absolutePath).replaceAll("\\", "/");
      if (relativePath.toLowerCase().includes(needleText)) results.push(relativePath);
    }
  }

  await visit(root);
  return results;
}
