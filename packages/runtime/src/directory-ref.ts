import { basename } from "node:path";
import type { DirectoryScopeRef } from "./directory-scope-types.ts";

/** In-memory directory scope row (not a Frontend Project or SQLite project). */
export function directoryRef(canonicalDirectory: string): DirectoryScopeRef {
  const now = new Date().toISOString();
  return {
    id: canonicalDirectory,
    displayName: basename(canonicalDirectory) || canonicalDirectory,
    path: canonicalDirectory,
    canonicalPath: canonicalDirectory,
    createdAt: now,
    updatedAt: now,
  };
}
