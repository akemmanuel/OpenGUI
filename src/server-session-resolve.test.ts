import { describe, expect, test, vi } from "vite-plus/test";
import type { BackendServiceContext } from "../server/services/index.ts";
import {
  resolveSessionRecordForMutation,
  resolveSessionRecordForRead,
} from "../server/services/session-resolve.ts";

function harnessServices(rawIds: string[] = []) {
  const ensureSession = vi.fn(async (row: unknown) => row);
  const listDirectorySessions = vi.fn(async () => [
    {
      harnessId: "pi" as const,
      sessions: rawIds.map((rawId) => ({
        id: rawId,
        title: "T",
        status: { type: "idle" },
      })),
    },
  ]);
  return {
    harnesses: { listDirectorySessions },
    sessions: {
      getSession: vi.fn(async () => null),
      ensureSession,
    },
    _ensureSession: ensureSession,
  } as unknown as BackendServiceContext & { _ensureSession: ReturnType<typeof vi.fn> };
}

describe("resolveSessionRecordForRead", () => {
  test("returns harness row when session is listed", async () => {
    const services = harnessServices(["raw-1"]);
    const row = await resolveSessionRecordForRead({
      services,
      sessionId: "pi:raw-1",
      scope: { directory: "/repo", harnessId: "pi" },
      resolveSafeDirectory: async (p) => p,
    });
    expect(row.id).toBe("pi:raw-1");
    expect(services._ensureSession).not.toHaveBeenCalled();
  });

  test("throws when session not in harness list", async () => {
    const services = harnessServices([]);
    await expect(
      resolveSessionRecordForRead({
        services,
        sessionId: "pi:missing",
        scope: { directory: "/repo", harnessId: "pi" },
        resolveSafeDirectory: async (p) => p,
      }),
    ).rejects.toThrow(/Session not found/);
  });

  test("throws when directory missing", async () => {
    const services = harnessServices([]);
    await expect(
      resolveSessionRecordForRead({
        services,
        sessionId: "pi:raw-1",
        scope: { harnessId: "pi" },
        resolveSafeDirectory: async (p) => p,
      }),
    ).rejects.toThrow(/directory is required/);
  });

  test("does not return recovered session stub", async () => {
    const services = harnessServices([]);
    await expect(
      resolveSessionRecordForRead({
        services,
        sessionId: "pi:ghost",
        scope: { directory: "/repo", harnessId: "pi" },
        resolveSafeDirectory: async (p) => p,
      }),
    ).rejects.toThrow(/Session not found/);
  });
});

describe("resolveSessionRecordForMutation", () => {
  test("warms index via ensureSession when harness lists the session", async () => {
    const harnessRow = {
      id: "pi:raw-1",
      rawId: "raw-1",
      directory: "/repo",
      harnessId: "pi" as const,
      title: "T",
      status: "idle" as const,
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    };
    const ensureSession = vi.fn(async () => harnessRow);
    const services = {
      harnesses: {
        listDirectorySessions: vi.fn(async () => [
          { harnessId: "pi" as const, sessions: [{ id: "raw-1", title: "T" }] },
        ]),
      },
      sessions: {
        getSession: vi.fn(async () => null),
        ensureSession,
      },
    } as unknown as BackendServiceContext;
    const row = await resolveSessionRecordForMutation({
      services,
      sessionId: "pi:raw-1",
      scope: { directory: "/repo", harnessId: "pi" },
      resolveSafeDirectory: async (p) => p,
    });
    expect(row.id).toBe("pi:raw-1");
    expect(ensureSession).toHaveBeenCalledTimes(1);
  });

  test("throws when session not in harness list (no recovered stub)", async () => {
    const services = harnessServices([]);
    await expect(
      resolveSessionRecordForMutation({
        services,
        sessionId: "pi:ghost",
        scope: { directory: "/repo", harnessId: "pi" },
        resolveSafeDirectory: async (p) => p,
      }),
    ).rejects.toThrow(/Session not found/);
  });

  test("surfaces harness list failure instead of falling through to not found", async () => {
    const services = {
      harnesses: {
        listDirectorySessions: vi.fn(async () => {
          throw new Error("Harness offline");
        }),
      },
      sessions: { getSession: vi.fn(async () => null), ensureSession: vi.fn() },
    } as unknown as BackendServiceContext;
    await expect(
      resolveSessionRecordForMutation({
        services,
        sessionId: "pi:raw-1",
        scope: { directory: "/repo", harnessId: "pi" },
        resolveSafeDirectory: async (p) => p,
      }),
    ).rejects.toThrow(/Harness offline/);
  });
});
