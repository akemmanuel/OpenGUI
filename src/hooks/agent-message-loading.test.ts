import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import type { MessageEntry, Session } from "@/hooks/agent-state-types";
import {
  collectChildSessionIds,
  fetchSessionMessagePage,
  hydrateChildSessionMessages,
  loadOlderSessionMessages,
} from "./agent-message-loading";

function makeSession(input: Partial<Session> & Pick<Session, "id">): Session {
  return {
    title: "Untitled",
    directory: "/repo",
    time: { created: 1, updated: 1 },
    ...input,
  } as Session;
}

function makeMessageEntry(childSessionId?: string): MessageEntry {
  return {
    info: { id: crypto.randomUUID(), sessionID: "parent", role: "assistant" } as never,
    parts: childSessionId
      ? ([
          {
            id: crypto.randomUUID(),
            type: "tool",
            tool: "Task",
            sessionID: "parent",
            messageID: crypto.randomUUID(),
            state: { metadata: { sessionId: childSessionId } },
          },
        ] as never)
      : [],
  };
}

describe("fetchSessionMessagePage", () => {
  test("uses the session backend and project target when fetching a page", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const messages = [makeMessageEntry()];

    const result = await fetchSessionMessagePage({
      sessionsClient: {
        getMessages: async (input) => {
          calls.push(input as Record<string, unknown>);
          return { messages, nextCursor: "cursor-1" };
        },
      },
      sessions: [
        makeSession({
          id: "pi:session-1",
          _harnessId: "pi",
          _projectDir: "/repo",
          _workspaceId: "workspace-1",
        }),
      ],
      sessionId: "pi:session-1",
    });

    expect(calls).toEqual([
      {
        sessionId: "pi:session-1",
        harnessId: "pi",
        options: {
          limit: 30,
          before: undefined,
          directory: "/repo",
          workspaceId: "workspace-1",
        },
      },
    ]);
    expect(result).toEqual({ messages, hasMore: true, nextCursor: "cursor-1" });
  });

  test("propagates getMessages failures instead of returning an empty thread", async () => {
    await expect(
      fetchSessionMessagePage({
        sessionsClient: {
          getMessages: async () => {
            throw new Error("Session not found");
          },
        },
        sessions: [
          makeSession({
            id: "pi:ghost",
            _harnessId: "pi",
            _projectDir: "/repo",
          }),
        ],
        sessionId: "pi:ghost",
      }),
    ).rejects.toThrow(/Session not found/);
  });

  test("requires directory before calling getMessages", async () => {
    const getMessages = vi.fn();
    await expect(
      fetchSessionMessagePage({
        sessionsClient: { getMessages },
        sessions: [
          makeSession({
            id: "pi:session-1",
            _harnessId: "pi",
            directory: "",
          }),
        ],
        sessionId: "pi:session-1",
      }),
    ).rejects.toThrow(/directory is required/);
    expect(getMessages).not.toHaveBeenCalled();
  });
});

describe("collectChildSessionIds", () => {
  test("deduplicates task child session ids", () => {
    expect(
      collectChildSessionIds([
        makeMessageEntry("child-1"),
        makeMessageEntry("child-1"),
        makeMessageEntry("child-2"),
      ]),
    ).toEqual(["child-1", "child-2"]);
  });
});

describe("hydrateChildSessionMessages", () => {
  test("loads each unique child session and dispatches its messages", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const actions: Array<Record<string, unknown>> = [];

    hydrateChildSessionMessages({
      messages: [
        makeMessageEntry("child-1"),
        makeMessageEntry("child-1"),
        makeMessageEntry("child-2"),
      ],
      parentSessionId: "pi:parent",
      projectTarget: { directory: "/repo", workspaceId: "workspace-1" },
      childHydrationVersions: {},
      getCurrentSelectSessionRequestId: () => 1,
      getCurrentActiveSessionId: () => "pi:parent",
      sessionsClient: {
        getMessages: async (input) => {
          calls.push(input as Record<string, unknown>);
          return {
            messages: [
              {
                info: { id: `${input.sessionId}-message`, sessionID: input.sessionId },
                parts: [],
              },
            ] as never,
          };
        },
      },
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual([
      {
        sessionId: "child-1",
        harnessId: "pi",
        options: { limit: 10000, directory: "/repo", workspaceId: "workspace-1" },
      },
      {
        sessionId: "child-2",
        harnessId: "pi",
        options: { limit: 10000, directory: "/repo", workspaceId: "workspace-1" },
      },
    ]);
    expect(actions).toEqual([
      {
        type: "LOAD_CHILD_SESSION",
        payload: {
          childSessionId: "child-1",
          messages: [
            {
              info: { id: "child-1-message", sessionID: "child-1" },
              parts: [],
            },
          ],
        },
      },
      {
        type: "LOAD_CHILD_SESSION",
        payload: {
          childSessionId: "child-2",
          messages: [
            {
              info: { id: "child-2-message", sessionID: "child-2" },
              parts: [],
            },
          ],
        },
      },
    ]);
  });

  test("drops stale child session loads when the selection request changes", async () => {
    const actions: Array<Record<string, unknown>> = [];

    hydrateChildSessionMessages({
      messages: [makeMessageEntry("child-1")],
      parentSessionId: "pi:parent",
      requestId: 1,
      childHydrationVersions: {},
      getCurrentSelectSessionRequestId: () => 2,
      getCurrentActiveSessionId: () => "pi:parent",
      sessionsClient: {
        getMessages: async () => ({
          messages: [{ info: { id: "child-1-message", sessionID: "child-1" }, parts: [] }] as never,
        }),
      },
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(actions).toEqual([]);
  });
});

describe("loadOlderSessionMessages", () => {
  test("prepends older messages when more history is available", async () => {
    const actions: Array<Record<string, unknown>> = [];

    const hasMore = await loadOlderSessionMessages({
      state: {
        activeSessionId: "session-1",
        messages: [makeMessageEntry()],
        isLoadingOlderMessages: false,
        messageHistoryHasMore: true,
        messageHistoryCursor: "cursor-1",
      },
      fetchMessagePage: async () => ({
        messages: [makeMessageEntry()],
        hasMore: true,
        nextCursor: "cursor-2",
      }),
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    expect(hasMore).toBe(true);
    expect(actions).toEqual([
      { type: "SET_LOADING_OLDER_MESSAGES", payload: true },
      {
        type: "SET_MESSAGES",
        payload: {
          messages: expect.any(Array),
          hasMore: true,
          nextCursor: "cursor-2",
          mode: "prepend",
        },
      },
    ]);
  });

  test("clears the loading flag when fetching older messages fails", async () => {
    const actions: Array<Record<string, unknown>> = [];

    const hasMore = await loadOlderSessionMessages({
      state: {
        activeSessionId: "session-1",
        messages: [makeMessageEntry()],
        isLoadingOlderMessages: false,
        messageHistoryHasMore: true,
        messageHistoryCursor: "cursor-1",
      },
      fetchMessagePage: async () => {
        throw new Error("boom");
      },
      dispatch: (action) => {
        actions.push(action as Record<string, unknown>);
      },
    });

    expect(hasMore).toBe(false);
    expect(actions).toEqual([
      { type: "SET_LOADING_OLDER_MESSAGES", payload: true },
      { type: "SET_LOADING_OLDER_MESSAGES", payload: false },
    ]);
  });
});
