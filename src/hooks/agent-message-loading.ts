import { getHarnessIdFromSessionId, type HarnessId } from "@/agents";
import { MESSAGE_PAGE_SIZE } from "@/hooks/agent-message-state";
import { resolveSessionHarnessRoute } from "@/hooks/agent-harness-routing";
import {
  directoryScopeForSessionApi,
  getSessionProjectTarget,
  type ProjectTarget,
} from "@/hooks/agent-session-utils";
import type { MessageEntry, Session } from "@/hooks/agent-state-types";

interface SessionsMessagesClient {
  getMessages(input: {
    sessionId: string;
    harnessId?: HarnessId;
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

export async function fetchSessionMessagePage({
  sessionsClient,
  sessions,
  sessionId,
  options,
  projectTarget,
  harnessId: harnessIdOverride,
}: {
  sessionsClient: SessionsMessagesClient;
  sessions: Session[];
  sessionId: string;
  options?: { before?: string; limit?: number };
  projectTarget?: ProjectTarget;
  /** Task/subagent child ids often omit a harness prefix; use the parent harness. */
  harnessId?: HarnessId;
}) {
  const pageSize = options?.limit ?? MESSAGE_PAGE_SIZE;
  const session = sessions.find((candidate) => candidate.id === sessionId);
  const resolvedTarget = projectTarget ?? getSessionProjectTarget(session);
  const directory =
    resolvedTarget?.directory ??
    directoryScopeForSessionApi(session) ??
    projectTarget?.directory ??
    (session?._projectDir ? String(session._projectDir) : undefined) ??
    (session?.directory ? String(session.directory) : undefined);
  const harnessId =
    harnessIdOverride ??
    resolveSessionHarnessRoute(session).harnessId ??
    getHarnessIdFromSessionId(sessionId) ??
    undefined;
  if (!directory?.trim()) {
    throw new Error("directory is required");
  }
  if (!harnessId) {
    throw new Error("harnessId is required");
  }
  const data = await sessionsClient.getMessages({
    sessionId,
    harnessId,
    options: {
      limit: pageSize,
      before: options?.before,
      directory,
      workspaceId: resolvedTarget?.workspaceId ?? projectTarget?.workspaceId,
      baseUrl: resolvedTarget?.baseUrl ?? projectTarget?.baseUrl,
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
