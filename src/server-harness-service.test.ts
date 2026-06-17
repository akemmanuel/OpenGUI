import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { HarnessService } from "@opengui/runtime";
import type { SessionRecord } from "../server/services/session-types.ts";

describe("HarnessService.respondPermission", () => {
  test("passes only harness execution scope to session-routed RPC", async () => {
    const calls: Array<{ channel: string; args?: unknown[] }> = [];
    const invoke = async <T>(channel: string, args?: unknown[]): Promise<T> => {
      calls.push({ channel, args });
      return { success: true } as T;
    };
    const service = new HarnessService(invoke, new Map(), ["opencode"]);

    const session: SessionRecord = {
      id: "session-1",
      rawId: "raw-session-1",
      directory: "project-1",
      harnessId: "opencode",
      title: "Work",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    await service.respondPermission({
      session,
      permissionId: "per-1",
      response: "once",
      scope: { directory: "/repo" },
    });

    expect(calls).toEqual([
      {
        channel: "opencode:permission",
        args: ["raw-session-1", "per-1", "once", "/repo"],
      },
    ]);
  });
});
