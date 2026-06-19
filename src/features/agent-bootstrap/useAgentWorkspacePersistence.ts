import { useEffect, useRef, type MutableRefObject } from "react";
import type { Dispatch } from "react";
import {
  getActiveWorkspaceId,
  getLegacyStoredDefaultChatDirectory,
  getWorkspaceDefaultChatDirectory,
  initializeBackendWorkspaceState,
} from "@/hooks/agent-state-persistence";
import type { Action } from "@/hooks/agent-reducer";
import type { OpenGuiClient } from "@/protocol/client";
import { getErrorMessage } from "@/lib/utils";

export function useAgentWorkspacePersistence(input: {
  openGuiClient: OpenGuiClient;
  dispatch: Dispatch<Action>;
  setWorkspaceStateReady: (ready: boolean) => void;
  pendingStartupSessionRestoreRef: MutableRefObject<string | null>;
}) {
  const { openGuiClient, dispatch, setWorkspaceStateReady, pendingStartupSessionRestoreRef } =
    input;
  const workspaceBootstrapRef = useRef(false);

  useEffect(() => {
    if (workspaceBootstrapRef.current) return;
    workspaceBootstrapRef.current = true;
    let cancelled = false;

    void initializeBackendWorkspaceState(openGuiClient)
      .then((workspaces) => {
        if (cancelled) return;
        dispatch({ type: "SET_WORKSPACES", payload: workspaces });
        const activeWorkspaceId = getActiveWorkspaceId(workspaces);
        dispatch({ type: "SET_ACTIVE_WORKSPACE", payload: activeWorkspaceId });
        const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
        const legacyDefaultChatDirectory = getLegacyStoredDefaultChatDirectory();
        pendingStartupSessionRestoreRef.current = activeWorkspace?.lastActiveSessionId ?? null;
        dispatch({
          type: "SET_DEFAULT_CHAT_DIRECTORY",
          payload: getWorkspaceDefaultChatDirectory(activeWorkspace) ?? legacyDefaultChatDirectory,
        });
        setWorkspaceStateReady(true);
      })
      .catch((error) => {
        if (cancelled) return;
        dispatch({
          type: "SET_ERROR",
          payload: getErrorMessage(error) || "Failed to load workspaces",
        });
        setWorkspaceStateReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [dispatch, openGuiClient, pendingStartupSessionRestoreRef, setWorkspaceStateReady]);
}
