import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { BackendServiceContext } from "../server/services/index.ts";
import { resolveSessionProjectRecord } from "../server/services/session-project-scope.ts";
import type { ProjectRecord } from "../server/services/storage-service.ts";
import type { SessionRecord } from "../server/services/session-types.ts";

async function resolveSafeDirectory(inputPath: string): Promise<string> {
  const requested = resolve(inputPath.trim());
  const actual = await realpath(requested);
  const info = await stat(actual);
  if (!info.isDirectory()) throw new Error("Path is not a directory");
  return actual;
}

describe("resolveSessionProjectRecord", () => {
  test("finds connected Project by path when session.projectId is canonical path", async () => {
    const repoPath = await resolveSafeDirectory(process.cwd());
    const now = "2026-01-01T00:00:00.000Z";
    const project: ProjectRecord = {
      id: "proj_uuid_connected",
      displayName: "OpenGUI",
      path: repoPath,
      canonicalPath: repoPath,
      createdAt: now,
      updatedAt: now,
    };
    const session: SessionRecord = {
      id: "session_1",
      rawId: "raw-1",
      projectId: repoPath,
      harnessId: "opencode",
      title: "Test",
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };

    const services = {
      projects: {
        getProject: async (id: string) => (id === project.id ? project : null),
        findProjectByPath: async () => project,
      },
    } as unknown as BackendServiceContext;

    const resolved = await resolveSessionProjectRecord({
      services,
      session,
      resolveSafeDirectory,
    });

    expect(resolved.id).toBe("proj_uuid_connected");
    expect(resolved.canonicalPath).toBe(repoPath);
  });

  test("falls back to metadata.directory when projectId is not a stored id", async () => {
    const repoPath = await resolveSafeDirectory(process.cwd());
    const now = "2026-01-01T00:00:00.000Z";
    const session: SessionRecord = {
      id: "session_2",
      rawId: "raw-2",
      projectId: "missing-project-id",
      harnessId: "opencode",
      title: "Test",
      status: "idle",
      createdAt: now,
      updatedAt: now,
      metadata: { directory: repoPath },
    };

    const services = {
      projects: {
        getProject: async () => null,
        findProjectByPath: async () => null,
      },
    } as unknown as BackendServiceContext;

    const resolved = await resolveSessionProjectRecord({
      services,
      session,
      resolveSafeDirectory,
    });

    expect(resolved.canonicalPath).toBe(repoPath);
    expect(resolved.path).toBe(repoPath);
  });
});
