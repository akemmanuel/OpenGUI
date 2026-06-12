import { useMemo } from "react";
import type { useConnectionState, useSessionState } from "@/hooks/use-agent-state";
import { parseProjectKey } from "@/hooks/agent-session-utils";
import { getChatSurfaceState, hasProjectConnectedPrompt } from "@/lib/chat-surface";
import { normalizeProjectPath } from "@/lib/utils";

type SessionState = ReturnType<typeof useSessionState>;
type ConnectionState = ReturnType<typeof useConnectionState>;

interface UseChatSessionSurfaceParams {
  sessions: SessionState["sessions"];
  activeSessionId: SessionState["activeSessionId"];
  activeTargetDirectory: SessionState["activeTargetDirectory"];
  connections: ConnectionState["connections"];
  defaultChatDirectory: ConnectionState["defaultChatDirectory"];
}

export function useChatSessionSurface({
  sessions,
  activeSessionId,
  activeTargetDirectory,
  connections,
  defaultChatDirectory,
}: UseChatSessionSurfaceParams) {
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [sessions, activeSessionId],
  );

  const activeSessionDirectory =
    activeSession?._projectDir ?? activeSession?.directory ?? activeTargetDirectory ?? null;

  const connectedTargetDirectories = useMemo(
    () =>
      Object.entries(connections)
        .filter(([, status]) => status.state === "connected")
        .map(([projectKey]) => normalizeProjectPath(parseProjectKey(projectKey).directory)),
    [connections],
  );

  const connectedProjectDirectories = useMemo(
    () =>
      Object.entries(connections)
        .filter(([, status]) => status.state === "connected" && status.kind !== "chat-infra")
        .map(([projectKey]) => normalizeProjectPath(parseProjectKey(projectKey).directory)),
    [connections],
  );

  const connectedActiveTargetDirectory = (() => {
    if (!activeTargetDirectory) return null;
    const normalizedActiveTarget = normalizeProjectPath(activeTargetDirectory);
    if (connectedTargetDirectories.includes(normalizedActiveTarget)) return activeTargetDirectory;
    if (normalizedActiveTarget === normalizeProjectPath(defaultChatDirectory ?? "")) {
      return activeTargetDirectory;
    }
    return null;
  })();

  const chatSurfaceState = useMemo(
    () =>
      getChatSurfaceState({
        activeSessionId,
        activeTargetDirectory: connectedActiveTargetDirectory,
        defaultChatDirectory,
      }),
    [connectedActiveTargetDirectory, defaultChatDirectory, activeSessionId],
  );

  const hasConnectedProjects = connectedProjectDirectories.length > 0;
  const showPromptBox = hasProjectConnectedPrompt(chatSurfaceState);

  return {
    activeSession,
    activeSessionDirectory,
    chatSurfaceState,
    hasConnectedProjects,
    showPromptBox,
  };
}
