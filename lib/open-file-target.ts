import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, win32 } from "node:path";

export function cleanOpenPath(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/^["']|["']$/g, "");
}

export function isPathInside(candidate: string, parent: string) {
  const childRelative = relative(parent, candidate);
  return (
    childRelative === "" ||
    (!!childRelative && !childRelative.startsWith("..") && !isAbsolute(childRelative))
  );
}

function isExpectedFileSystemError(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return ["EACCES", "EBUSY", "ELOOP", "EMFILE", "ENOENT", "ENOTDIR", "EPERM"].includes(
    String(error.code),
  );
}

export async function resolveFileTarget(filePath: unknown, baseDirectory?: unknown) {
  const target = cleanOpenPath(filePath);
  if (!target || target.includes("\0")) return null;

  const base = cleanOpenPath(baseDirectory);
  const normalizedBase = base ? resolve(base) : null;
  if (!normalizedBase) return null;

  const targetAbsolute =
    isAbsolute(target) || (process.platform === "win32" && win32.isAbsolute(target));
  const resolved = targetAbsolute ? resolve(target) : resolve(normalizedBase, target);
  if (!isPathInside(resolved, normalizedBase)) return null;

  try {
    const realBase = await realpath(normalizedBase);
    const realResolved = await realpath(resolved);
    if (!isPathInside(realResolved, realBase)) return null;
    await access(realResolved);
    if (!(await stat(realResolved)).isFile()) return null;
    return realResolved;
  } catch (error) {
    if (!isExpectedFileSystemError(error)) throw error;
    return null;
  }
}
