import { describe, expect, test } from "vite-plus/test";
import type { Session } from "@/hooks/agent-state-types";
import {
  processAfterPartQueueTriggers,
  processBusyToIdleTransitions,
} from "./agent-queue-dispatch";

function makeSession(input: Partial<Session> & Pick<Session, "id">): Session {
  return {
    title: "Untitled",
    directory: "/repo",
    time: { created: 1, updated: 1 },
    ...input,
  } as Session;
}

describe("processBusyToIdleTransitions", () => {
  test("marks newly idle sessions and refreshes the active session", () => {
    const refreshed: Array<Record<string, unknown>> = [];

    const result = processBusyToIdleTransitions({
      previousBusySessionIds: new Set(["session-1", "session-2"]),
      currentBusySessionIds: new Set(["session-2"]),
      activeSessionId: "session-1",
      sessionMeta: {},
      sessions: [
        makeSession({
          id: "session-1",
          _projectDir: "/repo",
          _workspaceId: "workspace-1",
        }),
      ],
      refreshSessionMessages: async (sessionId, projectTarget) => {
        refreshed.push({ sessionId, projectTarget });
      },
    });

    expect(result).toEqual({ "session-1": true });
    expect(refreshed).toEqual([
      {
        sessionId: "session-1",
        projectTarget: { directory: "/repo", workspaceId: "workspace-1" },
      },
    ]);
  });

  test("refreshes newly idle moved sessions at the execution target", () => {
    const refreshed: Array<Record<string, unknown>> = [];

    processBusyToIdleTransitions({
      previousBusySessionIds: new Set(["session-1"]),
      currentBusySessionIds: new Set(),
      activeSessionId: "session-1",
      sessionMeta: { "session-1": { displayProjectDir: "/project-b" } },
      sessions: [
        makeSession({
          id: "session-1",
          _projectDir: "/project-a",
          _workspaceId: "workspace-1",
        }),
      ],
      refreshSessionMessages: async (sessionId, projectTarget) => {
        refreshed.push({ sessionId, projectTarget });
      },
    });

    expect(refreshed).toEqual([
      {
        sessionId: "session-1",
        projectTarget: { directory: "/project-a", workspaceId: "workspace-1" },
      },
    ]);
  });
});

describe("processAfterPartQueueTriggers", () => {
  test("clears the trigger and aborts each session", () => {
    const actions: Array<Record<string, unknown>> = [];
    const aborts: Array<Record<string, unknown>> = [];

    processAfterPartQueueTriggers({
      sessionIds: ["session-1", "session-2"],
      abortSession: async (input) => {
        aborts.push(input);
      },
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    expect(actions).toEqual([
      {
        type: "CLEAR_AFTER_PART_TRIGGERED",
        payload: { sessionID: "session-1" },
      },
      {
        type: "CLEAR_AFTER_PART_TRIGGERED",
        payload: { sessionID: "session-2" },
      },
    ]);
    expect(aborts).toEqual([{ sessionId: "session-1" }, { sessionId: "session-2" }]);
  });
});
