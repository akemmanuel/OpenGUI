import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { OpencodeProjectRegistry } from "./opencode-project-registry";

describe("OpencodeProjectRegistry", () => {
  test("resolves Project connections by exact directory instead of ancestor directory", () => {
    const registry = new OpencodeProjectRegistry<string>();
    registry.setConnection(
      { workspaceId: "local", directory: "/home/emmanuel" },
      "home-connection",
    );

    expect(
      registry.getExactConnectionEntry({
        workspaceId: "local",
        directory: "/home/emmanuel/Code/OpenGUI",
      }),
    ).toBeNull();

    expect(
      registry.getExactConnectionEntry({
        workspaceId: "local",
        directory: "/home/emmanuel",
      }),
    ).toEqual({
      projectKey: "local\u0000/home/emmanuel",
      connection: "home-connection",
    });
  });

  test("tracks raw session ids per Project connection", () => {
    const registry = new OpencodeProjectRegistry<string>();
    const { projectKey } = registry.setConnection(
      { workspaceId: "local", directory: "/repo" },
      "repo-connection",
    );

    registry.rememberSessions(projectKey, [
      { id: "raw-a" },
      { id: "opencode:tagged", _rawId: "raw-b" },
    ]);

    expect(registry.getMappedSessionConnectionEntry("raw-a")).toEqual({
      projectKey,
      connection: "repo-connection",
    });
    expect(registry.getMappedSessionConnectionEntry("raw-b")).toEqual({
      projectKey,
      connection: "repo-connection",
    });
  });

  test("removing a Project connection clears session and question mappings", () => {
    const registry = new OpencodeProjectRegistry<string>();
    const { projectKey } = registry.setConnection(
      { workspaceId: "local", directory: "/repo" },
      "repo-connection",
    );

    registry.rememberSession(projectKey, "session-1");
    registry.rememberQuestion(projectKey, "question-1");

    expect(registry.removeProject(projectKey)).toEqual({
      connection: "repo-connection",
      removedSessionIds: ["session-1"],
      removedQuestionIds: ["question-1"],
    });
    expect(registry.getMappedSessionConnectionEntry("session-1")).toBeNull();
    expect(registry.getMappedQuestionConnectionEntry("question-1")).toBeNull();
  });

  test("separates the same directory across workspaces", () => {
    const registry = new OpencodeProjectRegistry<string>();
    registry.setConnection({ workspaceId: "workspace-a", directory: "/repo" }, "a");
    registry.setConnection({ workspaceId: "workspace-b", directory: "/repo" }, "b");

    expect(
      registry.getExactConnectionEntry({ workspaceId: "workspace-a", directory: "/repo" }),
    )?.toMatchObject({ connection: "a" });
    expect(
      registry.getExactConnectionEntry({ workspaceId: "workspace-b", directory: "/repo" }),
    )?.toMatchObject({ connection: "b" });
  });
});
