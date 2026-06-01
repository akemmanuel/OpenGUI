import { getAgentBackendIdFromSessionId, type AgentBackendId } from "@/agents";
import { getChildSessionId, MESSAGE_PAGE_SIZE } from "@/hooks/agent-message-state";
import {
  getSessionBackendId,
  getSessionProjectTarget,
  type ProjectTarget,
} from "@/hooks/agent-session-utils";
import type { MessageEntry, Session } from "@/hooks/agent-state-types";

interface SessionsMessagesClient {
  getMessages(input: {
    sessionId: string;
    backendId?: AgentBackendId;
    options: {
      limit: number;
      before?: string;
      directory?: string;
      workspaceId?: string;
      baseUrl?: string;
    };
  }): Promise<{
    messages?: MessageEntry[];
    nextCursor?: string | null;
  }>;
}

type MessageLoadingDispatch =
  | {
      type: "SET_MESSAGES";
      payload: {
        messages: MessageEntry[];
        hasMore: boolean;
        nextCursor?: string | null;
        mode?: "replace" | "prepend" | "append";
      };
    }
  | { type: "SET_LOADING_OLDER_MESSAGES"; payload: boolean }
  | {
      type: "LOAD_CHILD_SESSION";
      payload: {
        childSessionId: string;
        messages: MessageEntry[];
      };
    };

export async function fetchSessionMessagePage({
  sessionsClient,
  sessions,
  sessionId,
  options,
  projectTarget,
}: {
  sessionsClient: SessionsMessagesClient;
  sessions: Session[];
  sessionId: string;
  options?: { before?: string; limit?: number };
  projectTarget?: ProjectTarget;
}) {
  const pageSize = options?.limit ?? MESSAGE_PAGE_SIZE;
  const session = sessions.find((candidate) => candidate.id === sessionId);
  const resolvedTarget = projectTarget ?? getSessionProjectTarget(session);
  const data = await sessionsClient.getMessages({
    sessionId,
    backendId: getSessionBackendId(session) ?? undefined,
    options: {
      limit: pageSize,
      before: options?.before,
      directory: resolvedTarget?.directory,
      workspaceId: resolvedTarget?.workspaceId,
      baseUrl: resolvedTarget?.baseUrl,
    },
  });
  const messages = data?.messages ?? [];
  const nextCursor = data?.nextCursor ?? null;

  return {
    messages,
    hasMore: nextCursor !== null,
    nextCursor,
  };
}

export function collectChildSessionIds(messages: MessageEntry[]) {
  const childSessionIds = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      const childSessionId = getChildSessionId(part);
      if (childSessionId) childSessionIds.add(childSessionId);
    }
  }
  return [...childSessionIds];
}

export function hydrateChildSessionMessages({
  messages,
  parentSessionId,
  requestId,
  projectTarget,
  childHydrationVersions,
  getCurrentSelectSessionRequestId,
  getCurrentActiveSessionId,
  sessionsClient,
  dispatch,
}: {
  messages: MessageEntry[];
  parentSessionId?: string;
  requestId?: number;
  projectTarget?: ProjectTarget;
  childHydrationVersions: Record<string, number>;
  getCurrentSelectSessionRequestId: () => number;
  getCurrentActiveSessionId: () => string | null;
  sessionsClient: SessionsMessagesClient;
  dispatch: (action: MessageLoadingDispatch) => void;
}) {
  if (messages.length === 0) return;

  const childSessionIds = collectChildSessionIds(messages);
  const backendId = parentSessionId
    ? (getAgentBackendIdFromSessionId(parentSessionId) ?? undefined)
    : undefined;

  for (const childSessionId of childSessionIds) {
    const nextVersion = (childHydrationVersions[childSessionId] ?? 0) + 1;
    childHydrationVersions[childSessionId] = nextVersion;

    void sessionsClient
      .getMessages({
        sessionId: childSessionId,
        backendId,
        options: {
          limit: 10000,
          directory: projectTarget?.directory,
          workspaceId: projectTarget?.workspaceId,
        },
      })
      .then((childResult) => {
        if (childHydrationVersions[childSessionId] !== nextVersion) return;
        if (requestId !== undefined && requestId !== getCurrentSelectSessionRequestId()) {
          return;
        }
        if (parentSessionId && parentSessionId !== getCurrentActiveSessionId()) {
          return;
        }
        const childMessages = childResult.messages;
        if (!childMessages) return;
        dispatch({
          type: "LOAD_CHILD_SESSION",
          payload: {
            childSessionId,
            messages: childMessages,
          },
        });
      })
      .catch(() => {
        /* best-effort child session fetch */
      });
  }
}

export async function loadOlderSessionMessages({
  state,
  fetchMessagePage,
  dispatch,
}: {
  state: {
    activeSessionId: string | null;
    messages: MessageEntry[];
    isLoadingOlderMessages: boolean;
    messageHistoryHasMore: boolean;
    messageHistoryCursor: string | null;
  };
  fetchMessagePage: (
    sessionId: string,
    options?: { before?: string; limit?: number },
  ) => Promise<{
    messages: MessageEntry[];
    hasMore: boolean;
    nextCursor: string | null;
  }>;
  dispatch: (action: MessageLoadingDispatch) => void;
}) {
  const {
    activeSessionId,
    messages,
    isLoadingOlderMessages,
    messageHistoryHasMore,
    messageHistoryCursor,
  } = state;

  if (
    !activeSessionId ||
    isLoadingOlderMessages ||
    !messageHistoryHasMore ||
    !messageHistoryCursor ||
    messages.length === 0
  ) {
    return false;
  }

  dispatch({ type: "SET_LOADING_OLDER_MESSAGES", payload: true });

  try {
    const result = await fetchMessagePage(activeSessionId, {
      before: messageHistoryCursor,
    });
    if (state.activeSessionId !== activeSessionId) return false;
    dispatch({
      type: "SET_MESSAGES",
      payload: {
        messages: result.messages,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
        mode: "prepend",
      },
    });
    return result.hasMore;
  } catch {
    dispatch({ type: "SET_LOADING_OLDER_MESSAGES", payload: false });
    return false;
  }
}
