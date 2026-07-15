import { describe, expect, test } from "vite-plus/test";
import { makeProjectKey } from "@/hooks/agent-session-utils";
import { partitionSidebarPins } from "../sidebar-pins";

describe("partitionSidebarPins", () => {
  const workspaceId = "local";
  const projectEntries = [
    [
      "/repo-a",
      [
        { id: "s1", directory: "/repo-a" },
        { id: "s2", directory: "/repo-a" },
      ],
    ],
    [
      "/repo-b",
      [
        { id: "s3", directory: "/repo-b" },
        { id: "s4", directory: "/repo-b" },
      ],
    ],
  ] as const;

  test("moves pinned project to pinned section and keeps its sessions together", () => {
    const result = partitionSidebarPins({
      projectEntries: [...projectEntries].map(([directory, sessions]) => [
        directory,
        [...sessions],
      ]),
      sessionMeta: {},
      projectMeta: {
        [makeProjectKey(workspaceId, "/repo-a")]: { pinnedAt: "2026-01-01T00:00:00.000Z" },
      },
      workspaceId,
    });

    expect(result.pinnedEntries).toHaveLength(1);
    expect(result.pinnedEntries[0]).toMatchObject({
      kind: "project",
      directory: "/repo-a",
    });
    expect(result.projectEntries.map(([directory]) => directory)).toEqual(["/repo-b"]);
  });

  test("moves pinned sessions to pinned section and filters them from project lists", () => {
    const result = partitionSidebarPins({
      projectEntries: [...projectEntries].map(([directory, sessions]) => [
        directory,
        [...sessions],
      ]),
      sessionMeta: {
        s2: { pinnedAt: "2026-01-01T00:00:00.000Z" },
        s4: { pinnedAt: "2026-01-02T00:00:00.000Z" },
      },
      projectMeta: {},
      workspaceId,
    });

    expect(result.pinnedEntries).toHaveLength(2);
    expect(result.pinnedEntries[0]).toMatchObject({
      kind: "session",
      session: { id: "s2" },
      projectDirectory: "/repo-a",
    });
    expect(result.pinnedEntries[1]).toMatchObject({
      kind: "session",
      session: { id: "s4" },
      projectDirectory: "/repo-b",
    });
    expect(result.projectEntries).toEqual([
      ["/repo-a", [{ id: "s1", directory: "/repo-a" }]],
      ["/repo-b", [{ id: "s3", directory: "/repo-b" }]],
    ]);
  });

  test("suppresses pinned session entries when parent project is pinned", () => {
    const result = partitionSidebarPins({
      projectEntries: [...projectEntries].map(([directory, sessions]) => [
        directory,
        [...sessions],
      ]),
      sessionMeta: {
        s1: { pinnedAt: "2026-01-02T00:00:00.000Z" },
      },
      projectMeta: {
        [makeProjectKey(workspaceId, "/repo-a")]: { pinnedAt: "2026-01-01T00:00:00.000Z" },
      },
      workspaceId,
    });

    expect(result.pinnedEntries).toHaveLength(1);
    expect(result.pinnedEntries[0]).toMatchObject({
      kind: "project",
      directory: "/repo-a",
    });
  });
});
