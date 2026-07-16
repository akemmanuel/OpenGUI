import { describe, expect, test, vi } from "vite-plus/test";
import type { HostSessionSummary } from "@/protocol/host-types";
import { loadHostSessionSummaries } from "./host-session-list";

function summary(id: string, projectDirectory: string): HostSessionSummary {
  return {
    id,
    projectDirectory,
    title: `${id} session`,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    status: "idle",
  };
}

describe("loadHostSessionSummaries", () => {
  test("loads sessions from every connected project", async () => {
    const sessionsByDirectory = new Map([
      ["/projects/alpha", [summary("alpha", "/projects/alpha")]],
      ["/projects/beta", [summary("beta", "/projects/beta")]],
    ]);
    const listSessions = vi.fn(
      async (directory: string) => sessionsByDirectory.get(directory) ?? [],
    );

    const sessions = await loadHostSessionSummaries({ listSessions }, [
      "/projects/alpha",
      "/projects/beta",
    ]);

    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(sessions.map((session) => session.id)).toEqual(["alpha", "beta"]);
  });
});
