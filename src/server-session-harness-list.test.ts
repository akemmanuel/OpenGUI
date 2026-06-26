import { describe, expect, test, vi } from "vite-plus/test";
import { listDirectorySessionsFromHarness } from "../server/services/session-harness-list.ts";
import type { BackendServiceContext } from "../server/services/index.ts";

describe("listDirectorySessionsFromHarness", () => {
  test("maps harness list without writing session index", async () => {
    const ensureSession = vi.fn();
    const services = {
      harnesses: {
        listDirectorySessions: async () => [
          {
            harnessId: "pi" as const,
            sessions: [
              {
                id: "raw-1",
                title: "Hello",
                status: { type: "idle" },
              },
            ],
          },
        ],
      },
      sessions: { ensureSession },
    } as unknown as BackendServiceContext;

    const sessions = await listDirectorySessionsFromHarness(
      services,
      { directory: "/repo", canonicalPath: "/repo" },
      "pi",
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: "pi:raw-1",
      rawId: "raw-1",
      directory: "/repo",
      harnessId: "pi",
      title: "Hello",
      status: "idle",
    });
    expect(ensureSession).not.toHaveBeenCalled();
  });
});
