import { describe, expect, test } from "vite-plus/test";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { BackendServiceContext } from "../server/services/index.ts";
import { resolveSessionDirectoryScopeRecord } from "../server/services/directory-scope.ts";
import type { SessionRecord } from "../server/services/session-types.ts";

async function resolveSafeDirectory(inputPath: string): Promise<string> {
  const requested = resolve(inputPath.trim());
  const actual = await realpath(requested);
  const info = await stat(actual);
  if (!info.isDirectory()) throw new Error("Path is not a directory");
  return actual;
}

describe("resolveSessionDirectoryScopeRecord", () => {
  test("uses canonical path when session.directory is a filesystem path", async () => {
    const repoPath = await resolveSafeDirectory(process.cwd());
    const now = "2026-01-01T00:00:00.000Z";
    const session: SessionRecord = {
      id: "session_1",
      rawId: "raw-1",
      directory: repoPath,
      harnessId: "opencode",
      title: "Test",
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };

    const services = {} as unknown as BackendServiceContext;

    const resolved = await resolveSessionDirectoryScopeRecord({
      services,
      session,
      resolveSafeDirectory,
    });

    expect(resolved.id).toBe(repoPath);
    expect(resolved.canonicalPath).toBe(repoPath);
  });

  test("falls back to metadata.directory when projectId is not a stored id", async () => {
    const repoPath = await resolveSafeDirectory(process.cwd());
    const now = "2026-01-01T00:00:00.000Z";
    const session: SessionRecord = {
      id: "session_2",
      rawId: "raw-2",
      directory: "missing-project-id",
      harnessId: "opencode",
      title: "Test",
      status: "idle",
      createdAt: now,
      updatedAt: now,
      metadata: { directory: repoPath },
    };

    const services = {} as unknown as BackendServiceContext;

    const resolved = await resolveSessionDirectoryScopeRecord({
      services,
      session,
      resolveSafeDirectory,
    });

    expect(resolved.canonicalPath).toBe(repoPath);
    expect(resolved.path).toBe(repoPath);
  });
});
