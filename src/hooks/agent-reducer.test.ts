import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { AgentBackendId } from "@/agents";
import type { Session } from "@/hooks/agent-state-types";
import { mergeProjectBackendSessions } from "./agent-reducer";

function session(id: string, backendId: AgentBackendId, directory = "/repo", updated = 1): Session {
  return {
    id,
    title: id,
    directory,
    _projectDir: directory,
    _workspaceId: "workspace-1",
    _backendId: backendId,
    time: { created: updated, updated },
  } as Session;
}

describe("mergeProjectBackendSessions", () => {
  test("replaces only sessions from listed backends", () => {
    const current = [session("open-old", "opencode"), session("pi-old", "pi")];
    const incoming = [session("pi-new", "pi", "/repo", 2)];

    const merged = mergeProjectBackendSessions({
      current,
      workspaceId: "workspace-1",
      directory: "/repo",
      incoming,
      backendIds: ["pi"],
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
      backendIds: [],
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
      backendIds: ["opencode"],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?._projectDir).toBe("/repo");
  });
});
