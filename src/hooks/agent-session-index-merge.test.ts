import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { HarnessId } from "@/agents";
import type { Session } from "@/hooks/agent-state-types";
import { mergeProjectBackendSessions } from "./agent-session-index-merge";

function session(id: string, harnessId: HarnessId, directory = "/repo", updated = 1): Session {
  return {
    id,
    title: id,
    directory,
    _projectDir: directory,
    _workspaceId: "workspace-1",
    _harnessId: harnessId,
    time: { created: updated, updated },
  } as Session;
}

const emptyRetain = {
  busySessionIds: new Set<string>(),
  activeTurnRunBySession: {},
  liveSessionRetainUntil: {},
};

describe("mergeProjectBackendSessions", () => {
  test("replaces only sessions from listed backends when not live", () => {
    const current = [session("open-old", "opencode"), session("pi-old", "pi")];
    const incoming = [session("pi-new", "pi", "/repo", 2)];

    const merged = mergeProjectBackendSessions({
      current,
      workspaceId: "workspace-1",
      directory: "/repo",
      incoming,
      harnessIds: ["pi"],
      retain: emptyRetain,
    });

    expect(merged.map((item) => item.id).sort()).toEqual(["open-old", "pi-new"]);
  });

  test("preserves sessions when backend listing failed", () => {
    const current = [session("open-old", "opencode"), session("pi-old", "pi")];

    const merged = mergeProjectBackendSessions({
      current,
      workspaceId: "workspace-1",
      directory: "/repo",
      incoming: [],
      harnessIds: [],
      retain: emptyRetain,
    });

    expect(merged.map((item) => item.id).sort()).toEqual(["open-old", "pi-old"]);
  });

  test("incoming id wins even when previous copy belonged to another directory", () => {
    const current = [session("same", "opencode", "/old", 1)];
    const incoming = [session("same", "opencode", "/repo", 2)];

    const merged = mergeProjectBackendSessions({
      current,
      workspaceId: "workspace-1",
      directory: "/repo",
      incoming,
      harnessIds: ["opencode"],
      retain: emptyRetain,
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?._projectDir).toBe("/repo");
  });

  test("retains busy in-scope session not yet in harness list", () => {
    const running = session("pi:running", "pi", "/repo", 2);
    const merged = mergeProjectBackendSessions({
      current: [running],
      workspaceId: "workspace-1",
      directory: "/repo",
      incoming: [],
      harnessIds: ["pi"],
      retain: {
        busySessionIds: new Set(["pi:running"]),
        activeTurnRunBySession: {},
        liveSessionRetainUntil: {},
      },
    });

    expect(merged.map((s) => s.id)).toEqual(["pi:running"]);
  });

  test("retains session within live retain window when list is empty", () => {
    const fresh = session("pi:fresh", "pi", "/repo", 2);
    const merged = mergeProjectBackendSessions({
      current: [fresh],
      workspaceId: "workspace-1",
      directory: "/repo",
      incoming: [],
      harnessIds: ["pi"],
      retain: {
        busySessionIds: new Set(),
        activeTurnRunBySession: {},
        liveSessionRetainUntil: { "pi:fresh": Date.now() + 60_000 },
      },
    });

    expect(merged.map((s) => s.id)).toEqual(["pi:fresh"]);
  });
});
