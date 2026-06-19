import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { fetchSessionMessagePage } from "./agent-message-loading";
import type { Session } from "./agent-state-types";

function makeSession(id: string): Session {
  return {
    id,
    title: id,
    directory: "/repo",
    _projectDir: "/repo",
    time: { created: 1, updated: 1 },
  } as Session;
}

describe("fetchSessionMessagePage", () => {
  test("requires directory and harnessId", async () => {
    await expect(
      fetchSessionMessagePage({
        sessionsClient: {
          getMessages: async () => ({ messages: [], nextCursor: null }),
        },
        sessions: [makeSession("s1")],
        sessionId: "s1",
      }),
    ).rejects.toThrow("harnessId is required");
  });

  test("returns messages and hasMore from client", async () => {
    const result = await fetchSessionMessagePage({
      sessionsClient: {
        getMessages: async () => ({
          messages: [
            {
              info: { id: "m1", sessionID: "pi:s1", role: "user", time: { created: 1 } },
              parts: [],
            } as never,
          ],
          nextCursor: "cursor-1",
        }),
      },
      sessions: [makeSession("pi:s1")],
      sessionId: "pi:s1",
      harnessId: "pi",
      projectTarget: { directory: "/repo" },
    });

    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("cursor-1");
    expect(result.messages).toHaveLength(1);
  });
});
