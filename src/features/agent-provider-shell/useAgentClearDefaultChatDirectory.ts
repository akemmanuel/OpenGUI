import { useCallback, type MutableRefObject } from "react";
import type { Action } from "@/hooks/agent-reducer-types";
import type { InternalAgentState } from "@/hooks/agent-state-types";
import { STORAGE_KEYS } from "@/lib/constants";
import { storageRemove } from "@/lib/safe-storage";

export function useAgentClearDefaultChatDirectory(input: {
  stateRef: MutableRefObject<InternalAgentState>;
  dispatch: (action: Action) => void;
}) {
  const { stateRef, dispatch } = input;

  return useCallback(() => {
    storageRemove(STORAGE_KEYS.DEFAULT_CHAT_DIRECTORY);
    const workspaceId = stateRef.current.activeWorkspaceId;
    const nextWorkspaces = stateRef.current.workspaces.map((workspace) =>
      workspace.id === workspaceId
        ? {
            ...workspace,
            settings: {
              ...workspace.settings,
              defaultChatDirectory: null,
            },
          }
        : workspace,
    );
    dispatch({ type: "SET_WORKSPACES", payload: nextWorkspaces });
    dispatch({ type: "SET_DEFAULT_CHAT_DIRECTORY", payload: null });
  }, [dispatch, stateRef]);
}
