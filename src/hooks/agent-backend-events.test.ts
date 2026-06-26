import { describe, expect, test } from "vite-plus/test";
import type { HarnessEvent } from "@/agents/backend";
import { handleHarnessEvent } from "./agent-backend-events";

function createTrackingState() {
  return {
    forcedTitles: new Map<string, string>(),
    pendingTitlePersistence: new Map<string, string>(),
    sessionIdAliases: new Map<string, string>(),
    namingRequestIds: new Map<string, number>(),
  };
}

describe("handleHarnessEvent", () => {
  test("ignores project-scoped events for unexpected project connections", () => {
    const actions: Array<Record<string, unknown>> = [];

    handleHarnessEvent({
      event: {
        type: "connection.status",
        directory: "/repo",
        workspaceId: "workspace-1",
        status: {
          state: "connected",
          serverUrl: "http://localhost:4096",
          serverVersion: null,
          error: null,
          lastEventAt: 1,
        },
      },
      expectedProjectKeys: new Set(),
      tracking: createTrackingState(),
      cleanupSessionRefs: () => undefined,
      renameSession: async () => undefined,
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    expect(actions).toEqual([]);
  });

  test("dispatches connection status for expected project connections", () => {
    const actions: Array<Record<string, unknown>> = [];

    handleHarnessEvent({
      event: {
        type: "connection.status",
        directory: "/repo",
        workspaceId: "workspace-1",
        status: {
          state: "connected",
          serverUrl: "http://localhost:4096",
          serverVersion: null,
          error: null,
          lastEventAt: 1,
        },
      },
      expectedProjectKeys: new Set(["workspace-1\u0000/repo"]),
      tracking: createTrackingState(),
      cleanupSessionRefs: () => undefined,
      renameSession: async () => undefined,
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    expect(actions).toEqual([
      {
        type: "SET_PROJECT_CONNECTION",
        payload: {
          projectKey: "workspace-1\u0000/repo",
          status: {
            state: "connected",
            serverUrl: "http://localhost:4096",
            serverVersion: null,
            error: null,
            lastEventAt: 1,
          },
        },
      },
    ]);
  });

  test("reconciles forced titles across session replacement and retries persistence", async () => {
    const actions: Array<Record<string, unknown>> = [];
    const renames: Array<Record<string, unknown>> = [];
    const tracking = createTrackingState();
    tracking.forcedTitles.set("old", "Pinned title");
    tracking.pendingTitlePersistence.set("old", "Pinned title");
    tracking.namingRequestIds.set("old", 3);

    handleHarnessEvent({
      event: {
        type: "session.replaced",
        directory: "/repo",
        workspaceId: "workspace-1",
        oldId: "old",
        newId: "pi:new",
        session: {
          id: "pi:new",
          title: "Backend title",
          directory: "/repo",
          time: { created: 1, updated: 1 },
        } as never,
      },
      expectedProjectKeys: new Set(["workspace-1\u0000/repo"]),
      tracking,
      cleanupSessionRefs: () => undefined,
      renameSession: async (input) => {
        renames.push(input);
      },
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(renames).toEqual([
      {
        sessionId: "pi:new",
        title: "Pinned title",
        harnessId: "pi",
      },
    ]);
    expect(tracking.forcedTitles.get("pi:new")).toBe("Pinned title");
    expect(tracking.sessionIdAliases.get("old")).toBe("pi:new");
    expect(tracking.namingRequestIds.get("pi:new")).toBe(3);
    expect(tracking.pendingTitlePersistence.has("pi:new")).toBe(false);
    expect(actions).toEqual([
      {
        type: "SESSION_REPLACED",
        payload: {
          oldId: "old",
          newId: "pi:new",
          session: expect.objectContaining({ id: "pi:new", title: "Pinned title" }),
        },
      },
    ]);
  });

  test("cleans up session refs before dispatching session deletion", () => {
    const actions: Array<Record<string, unknown>> = [];
    const cleaned: string[][] = [];

    handleHarnessEvent({
      event: {
        type: "session.deleted",
        directory: "/repo",
        workspaceId: "workspace-1",
        sessionId: "session-1",
      },
      expectedProjectKeys: new Set(["workspace-1\u0000/repo"]),
      tracking: createTrackingState(),
      cleanupSessionRefs: (ids) => {
        cleaned.push(Array.from(ids ?? []));
      },
      renameSession: async () => undefined,
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    expect(cleaned).toEqual([["session-1"]]);
    expect(actions).toEqual([{ type: "SESSION_DELETED", payload: "session-1" }]);
  });

  test("ignores projected transcript.message in favor of canonical live-session updates", () => {
    const actions: Array<Record<string, unknown>> = [];

    handleHarnessEvent({
      event: {
        type: "transcript.message",
        scope: { directory: "/repo", harnessId: "pi", sessionId: "pi:session-1" },
        revision: 2,
        entry: {
          info: { id: "m1", sessionID: "pi:session-1", role: "assistant", time: { created: 1 } },
          parts: [
            { id: "p1", type: "text", text: "hi", sessionID: "pi:session-1", messageID: "m1" },
          ],
        },
      } as unknown as HarnessEvent,
      expectedProjectKeys: new Set(["local\u0000/repo"]),
      tracking: createTrackingState(),
      cleanupSessionRefs: () => undefined,
      renameSession: async () => undefined,
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    expect(actions).toEqual([]);
  });

  test("delegates projected transcript.snapshot to ingestProjectedTranscriptEvent", () => {
    const actions: Array<Record<string, unknown>> = [];
    let ingested = false;

    handleHarnessEvent({
      event: {
        type: "transcript.snapshot",
        scope: { directory: "/repo", harnessId: "pi", sessionId: "pi:session-1" },
        revision: 1,
        page: {
          revision: 1,
          messages: [],
          nextCursor: null,
        },
      } as unknown as HarnessEvent,
      expectedProjectKeys: new Set(["local\u0000/repo"]),
      tracking: createTrackingState(),
      cleanupSessionRefs: () => undefined,
      renameSession: async () => undefined,
      ingestProjectedTranscriptEvent: () => {
        ingested = true;
        return true;
      },
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    expect(ingested).toBe(true);
    expect(actions).toHaveLength(0);
  });

  test("drops projected transcript events outside expected project scope", () => {
    const actions: Array<Record<string, unknown>> = [];

    handleHarnessEvent({
      event: {
        type: "transcript.message",
        scope: { directory: "/other", harnessId: "pi", sessionId: "pi:session-1" },
        revision: 2,
        entry: {
          info: { id: "m1", sessionID: "pi:session-1", role: "assistant", time: { created: 1 } },
          parts: [],
        },
      } as unknown as HarnessEvent,
      expectedProjectKeys: new Set(["local\u0000/repo"]),
      tracking: createTrackingState(),
      cleanupSessionRefs: () => undefined,
      renameSession: async () => undefined,
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    expect(actions).toEqual([]);
  });

  test("ignores session.status busy/idle in favor of canonical live run events", () => {
    const actions: Array<Record<string, unknown>> = [];

    handleHarnessEvent({
      event: {
        type: "session.status",
        sessionID: "session-1",
        status: { type: "busy" },
      },
      expectedProjectKeys: new Set(),
      tracking: createTrackingState(),
      cleanupSessionRefs: () => undefined,
      renameSession: async () => undefined,
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    expect(actions).toEqual([]);
  });

  test("still dispatches session.status retry for harness retry signals", () => {
    const actions: Array<Record<string, unknown>> = [];

    handleHarnessEvent({
      event: {
        type: "session.status",
        sessionID: "session-1",
        status: { type: "retry", message: "rate limited" },
      },
      expectedProjectKeys: new Set(),
      tracking: createTrackingState(),
      cleanupSessionRefs: () => undefined,
      renameSession: async () => undefined,
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    expect(actions).toEqual([
      {
        type: "SESSION_STATUS",
        payload: {
          sessionID: "session-1",
          status: { type: "retry", message: "rate limited" },
        },
      },
    ]);
  });

  test("surfaces session-scoped and global session errors", () => {
    const actions: Array<Record<string, unknown>> = [];
    const dispatch = (action: Record<string, unknown>) => {
      actions.push(action);
    };

    const sessionScoped: HarnessEvent = {
      type: "session.error",
      error: "visible in session",
      sessionID: "session-1",
    };
    const globalError: HarnessEvent = {
      type: "session.error",
      error: "visible globally",
    };

    handleHarnessEvent({
      event: sessionScoped,
      expectedProjectKeys: new Set(),
      tracking: createTrackingState(),
      cleanupSessionRefs: () => undefined,
      renameSession: async () => undefined,
      dispatch: dispatch as never,
    });
    handleHarnessEvent({
      event: globalError,
      expectedProjectKeys: new Set(),
      tracking: createTrackingState(),
      cleanupSessionRefs: () => undefined,
      renameSession: async () => undefined,
      dispatch: dispatch as never,
    });

    expect(actions).toEqual([
      {
        type: "SESSION_ERROR",
        payload: { sessionID: "session-1", error: "visible in session" },
      },
      {
        type: "SESSION_ERROR",
        payload: { sessionID: undefined, error: "visible globally" },
      },
    ]);
  });
});
