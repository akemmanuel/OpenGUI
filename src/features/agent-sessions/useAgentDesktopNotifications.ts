import { useDesktopNotification } from "@/hooks/agent-notifications";
import type { InternalAgentState } from "@/hooks/agent-state-types";

export function useAgentDesktopNotifications(input: {
  justIdledMap: Record<string, true>;
  state: InternalAgentState;
  selectSession: (id: string | null, options?: unknown) => Promise<void>;
}) {
  const { justIdledMap, state, selectSession } = input;
  const notifySelect = (id: string) => {
    void selectSession(id);
  };

  useDesktopNotification(
    justIdledMap,
    "Session complete",
    state.activeSessionId,
    state.sessions,
    notifySelect,
  );

  useDesktopNotification(
    state.pendingQuestions,
    "Question waiting",
    state.activeSessionId,
    state.sessions,
    notifySelect,
  );

  useDesktopNotification(
    state.pendingPermissions,
    "Permission requested",
    state.activeSessionId,
    state.sessions,
    notifySelect,
  );
}
