import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import type { HarnessId } from "./agents/index.ts";
import type { BackendServiceContext } from "../server/services/index.ts";
import {
  listSessionsForRequest,
  querySessionsForResolvedProjects,
} from "../server/services/session-query.ts";

describe("querySessionsForResolvedProjects", () => {
  test("always lists from harness per project and harnessId", async () => {
    const listDirectorySessions = vi.fn(async () => [
      {
        harnessId: "pi" as const,
        sessions: [{ id: "raw-1", title: "One", status: { type: "idle" } }],
      },
    ]);
    const services = {
      harnesses: { listDirectorySessions },
    } as unknown as BackendServiceContext;

    const result = await querySessionsForResolvedProjects({
      services,
      projects: [{ directory: "/repo", canonicalPath: "/repo" }],
      harnessIds: ["pi"],
    });

    expect(listDirectorySessions).toHaveBeenCalledWith({
      directory: "/repo",
      harnessIds: ["pi"],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      directory: "/repo",
      harnessId: "pi",
      sessions: [expect.objectContaining({ id: "pi:raw-1", title: "One" })],
    });
    expect(result.errors).toEqual([]);
  });

  test("returns per-scope error when harness list fails", async () => {
    const services = {
      harnesses: {
        listDirectorySessions: async () => {
          throw new Error("pi offline");
        },
      },
    } as unknown as BackendServiceContext;

    const result = await querySessionsForResolvedProjects({
      services,
      projects: [{ directory: "/repo", canonicalPath: "/repo" }],
      harnessIds: ["pi" as HarnessId],
    });

    expect(result.items).toEqual([]);
    expect(result.errors).toEqual([{ directory: "/repo", harnessId: "pi", error: "pi offline" }]);
  });
});

describe("listSessionsForRequest", () => {
  test("requires directory and harnessId and lists from harness", async () => {
    const services = {
      harnesses: {
        listDirectorySessions: async () => [
          {
            harnessId: "codex" as const,
            sessions: [{ id: "s1", title: "T", status: { type: "idle" } }],
          },
        ],
      },
    } as unknown as BackendServiceContext;

    const value = await listSessionsForRequest({
      services,
      directory: "/work",
      harnessId: "codex",
      resolveDirectory: async (dir) => ({ directory: dir, canonicalPath: dir }),
    });

    expect(value.sessions).toHaveLength(1);
    expect(value.nextCursor).toBeNull();
  });

  test("throws when directory or harnessId missing", async () => {
    const services = { harnesses: {} } as unknown as BackendServiceContext;
    const resolveDirectory = async (dir: string) => ({
      directory: dir,
      canonicalPath: dir,
    });

    await expect(
      listSessionsForRequest({
        services,
        harnessId: "pi",
        resolveDirectory,
      }),
    ).rejects.toThrow(/directory is required/);

    await expect(
      listSessionsForRequest({
        services,
        directory: "/x",
        resolveDirectory,
      }),
    ).rejects.toThrow(/harnessId is required/);
  });
});
