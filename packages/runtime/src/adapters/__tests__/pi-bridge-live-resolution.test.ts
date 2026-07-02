import { describe, expect, test } from "vite-plus/test";
import { createAssistantInfo, createBundle } from "../pi-bridge-mapping.ts";
import {
  findCurrentAssistantBundleInCache,
  pairPendingAssistantsWithCanonical,
  resolveAssistantBundleCandidateIds,
  resolvePiProjectForSession,
} from "../pi-bridge-live-resolution.ts";
import { createEmptyPiProjectShell } from "../pi-project-slot.ts";

function mockProject(directory: string, workspaceId?: string) {
  return createEmptyPiProjectShell("k", directory, workspaceId);
}

describe("resolveAssistantBundleCandidateIds", () => {
  test("includes synthetic id and mapped real id", () => {
    const map = new Map([["syn-1", "real-1"]]);
    const ids = resolveAssistantBundleCandidateIds({
      currentAssistantMessageId: "syn-1",
      syntheticToReal: map,
    });
    expect(ids).toEqual(["syn-1", "real-1"]);
  });
});

describe("findCurrentAssistantBundleInCache", () => {
  test("prefers mapped real bundle over stale synthetic when both exist", () => {
    const sessionId = "s1";
    const synthetic = createBundle(
      createAssistantInfo({
        sessionId,
        messageId: "syn",
        timestamp: 1,
        createdAt: 100,
      }),
      [],
    );
    const real = createBundle(
      createAssistantInfo({
        sessionId,
        messageId: "real",
        timestamp: 2,
        createdAt: 200,
      }),
      [],
    );
    const project = {
      sessionCaches: new Map([
        [
          sessionId,
          {
            messages: [synthetic, real],
          },
        ],
      ]),
    };
    const state = {
      currentAssistantMessageId: "syn",
      syntheticToReal: new Map([["syn", "real"]]),
    };
    const found = findCurrentAssistantBundleInCache(project, sessionId, state);
    expect(found?.messageId).toBe("syn");
    expect(found?.bundle.info.id).toBe("syn");
  });

  test("follows syntheticToReal to active bundle for tool routing", () => {
    const sessionId = "s1";
    const real = createBundle(
      createAssistantInfo({
        sessionId,
        messageId: "real",
        timestamp: 2,
        createdAt: 200,
      }),
      [],
    );
    const project = {
      sessionCaches: new Map([[sessionId, { messages: [real] }]]),
    };
    const state = {
      currentAssistantMessageId: "syn",
      syntheticToReal: new Map([["syn", "real"]]),
    };
    const found = findCurrentAssistantBundleInCache(project, sessionId, state);
    expect(found?.messageId).toBe("real");
    expect(found?.bundle.info.id).toBe("real");
  });
});

describe("pairPendingAssistantsWithCanonical", () => {
  test("pairs by closest created time, not insertion order after compaction", () => {
    const pending = [
      { syntheticId: "syn-a", startedAt: 1000 },
      { syntheticId: "syn-b", startedAt: 5000 },
    ];
    const newAssistants = [
      createBundle(
        createAssistantInfo({
          sessionId: "s1",
          messageId: "canon-b",
          timestamp: 1,
          createdAt: 5100,
        }),
        [],
      ),
      createBundle(
        createAssistantInfo({
          sessionId: "s1",
          messageId: "canon-a",
          timestamp: 1,
          createdAt: 1100,
        }),
        [],
      ),
    ];
    const pairs = pairPendingAssistantsWithCanonical(pending, newAssistants);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toMatchObject({
      pending: { syntheticId: "syn-a" },
      bundle: { info: { id: "canon-a" } },
    });
    expect(pairs[1]).toMatchObject({
      pending: { syntheticId: "syn-b" },
      bundle: { info: { id: "canon-b" } },
    });
  });

  test("does not pair canonical assistant outside time window", () => {
    const pending = [{ syntheticId: "syn-a", startedAt: 1000 }];
    const newAssistants = [
      createBundle(
        createAssistantInfo({
          sessionId: "s1",
          messageId: "canon-far",
          timestamp: 1,
          createdAt: 200_000,
        }),
        [],
      ),
    ];
    expect(pairPendingAssistantsWithCanonical(pending, newAssistants)).toHaveLength(0);
  });
});

describe("resolvePiProjectForSession", () => {
  test("uses explicit directory", async () => {
    const ensured: string[] = [];
    const project = await resolvePiProjectForSession(
      {
        projects: { size: 2, values: () => [][Symbol.iterator](), get: () => undefined },
        sessionIndex: new Map(),
        findLiveProjectKey: () => undefined,
        ensureProject: async (t) => {
          ensured.push(t.directory);
          return mockProject(t.directory, t.workspaceId);
        },
      },
      "s1",
      { directory: "/repo/" },
    );
    expect(project.directory).toBe("/repo");
    expect(ensured).toEqual(["/repo"]);
  });

  test("resolves via sessionIndex when directory omitted", async () => {
    const project = await resolvePiProjectForSession(
      {
        projects: { size: 2, values: () => [][Symbol.iterator](), get: () => undefined },
        sessionIndex: new Map([
          ["s1", { projectKey: "k", directory: "/indexed", workspaceId: "w" }],
        ]),
        findLiveProjectKey: () => undefined,
        ensureProject: async (t) => mockProject(t.directory, t.workspaceId),
      },
      "s1",
      {},
    );
    expect(project.directory).toBe("/indexed");
  });

  test("single registered project when no hints", async () => {
    const only = mockProject("/only");
    const project = await resolvePiProjectForSession(
      {
        projects: {
          size: 1,
          values: () => [only][Symbol.iterator](),
          get: () => only,
        },
        sessionIndex: new Map(),
        findLiveProjectKey: () => undefined,
        ensureProject: async () => only,
      },
      "s1",
      {},
    );
    expect(project.directory).toBe("/only");
  });

  test("throws when multiple projects and no directory", async () => {
    const a = mockProject("/a");
    const b = mockProject("/b");
    await expect(
      resolvePiProjectForSession(
        {
          projects: {
            size: 2,
            values: () => [a, b][Symbol.iterator](),
            get: (key) => (key === "a" ? a : b),
          },
          sessionIndex: new Map(),
          findLiveProjectKey: () => undefined,
          ensureProject: async (t) => mockProject(t.directory),
        },
        "s1",
        {},
      ),
    ).rejects.toThrow(/Project directory/);
  });
});
