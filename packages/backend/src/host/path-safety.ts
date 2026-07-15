import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export function normalizeAllowedRoots(roots: string[]) {
  return roots.map((entry) => resolve(entry.trim())).filter(Boolean);
}

export function isWithinAllowedRoot(path: string, allowedRoots: string[]) {
  return allowedRoots.some((root) => {
    const pathFromRoot = relative(root, path);
    return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
  });
}

export async function resolveSafeDirectory(
  inputPath: string | null | undefined,
  allowedRoots: string[],
) {
  const roots = allowedRoots.length ? allowedRoots : [homedir()];
  const requested = resolve(inputPath?.trim() || roots[0] || homedir());
  const actual = await realpath(requested);
  const info = await stat(actual);
  if (!info.isDirectory()) throw new Error("Path is not a directory");
  if (!isWithinAllowedRoot(actual, roots)) throw new Error("Path outside allowedRoots");
  return actual;
}
