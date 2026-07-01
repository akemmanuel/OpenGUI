import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { HarnessId } from "@/agents";
import { resolvePendingPromptCreationHarnessRoute } from "@/hooks/agent-harness-routing";
import type { Action } from "@/hooks/agent-reducer";
import { resolveServerDefaultModel } from "@/hooks/agent-model-selection";
import type { InternalAgentState } from "@/hooks/agent-state-types";
import { resolvePromptBoxHarnessId } from "@/hooks/prompt-box-selection";
import { STORAGE_KEYS } from "@/lib/constants";
import { getNewChatModelBehavior } from "@/lib/new-chat-model-behavior";
import { storageRemove, storageSet } from "@/lib/safe-storage";
import { normalizeProjectPath } from "@/lib/utils";
import type { OpenGuiClient } from "@/protocol/client";
import type { SelectedModel } from "@/types/electron";
import { parseProjectKey } from "@/hooks/agent-session-utils";
import type { HarnessDescriptor } from "@/agents/backend";

export function useAgentPromptTargetActions(input: {
  state: InternalAgentState;
  dispatch: Dispatch<Action>;
  getState: () => InternalAgentState;
  openGuiClient: OpenGuiClient;
  runtime: HarnessDescriptor["runtime"] | undefined;
  activeSessionHarnessId: HarnessId | null | undefined;
  preferredHarnessId: HarnessId;
  setPreferredHarnessId: Dispatch<SetStateAction<HarnessId>>;
  setModel: (model: SelectedModel | null) => void;
  ensureDirectoryConnection: (
    directory: string,
    options?: {
      hidden?: boolean;
      transient?: boolean;
      harnessIds?: HarnessId[];
    },
  ) => Promise<void>;
  activeResourceDirectory: string | null;
  activeResourceHarnessId: HarnessId;
  activeWorkspaceId: string | undefined;
  loadServerResources: (
    harnessId: HarnessId,
    directory: string | undefined,
    workspaceId: string | undefined,
    options?: { force?: boolean },
  ) => Promise<void>;
  clearResourceLoadDedupe: () => void;
  loadedResourceProjectKeyRef: { current: string | null };
}) {
  const {
    state,
    dispatch,
    getState,
    openGuiClient,
    runtime,
    activeSessionHarnessId,
    preferredHarnessId,
    setPreferredHarnessId,
    setModel,
    ensureDirectoryConnection,
    activeResourceDirectory,
    activeResourceHarnessId,
    activeWorkspaceId,
    loadServerResources,
    clearResourceLoadDedupe,
    loadedResourceProjectKeyRef,
  } = input;

  const setDefaultChatDirectory = useCallback(
    (directory: string | null) => {
      const normalizedDirectory = directory ? normalizeProjectPath(directory) : null;
      storageRemove(STORAGE_KEYS.DEFAULT_CHAT_DIRECTORY);
      const workspaceId = getState().activeWorkspaceId;
      const nextWorkspaces = getState().workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              settings: {
                ...workspace.settings,
                defaultChatDirectory: normalizedDirectory,
              },
            }
          : workspace,
      );
      dispatch({ type: "SET_WORKSPACES", payload: nextWorkspaces });
      dispatch({
        type: "SET_DEFAULT_CHAT_DIRECTORY",
        payload: normalizedDirectory,
      });

      const workspace = nextWorkspaces.find((item) => item.id === workspaceId);
      if (!workspace || !normalizedDirectory) return;
      const alreadyProject = workspace.projects.some(
        (project) => normalizeProjectPath(project) === normalizedDirectory,
      );
      if (alreadyProject) return;

      void ensureDirectoryConnection(normalizedDirectory, {
        hidden: true,
        transient: true,
      }).catch(() => {
        /* default chat verification/indexing is best effort */
      });
    },
    [dispatch, ensureDirectoryConnection, getState],
  );

  const setActiveTarget = useCallback(
    (
      directory: string,
      harnessId?: HarnessId | null,
      options?: { resetSelection?: boolean; newChat?: boolean },
    ) => {
      const payload: {
        directory: string;
        harnessId: HarnessId | null;
        resetSelection?: boolean;
        selectedModel?: SelectedModel | null;
        selectedAgent?: string | null;
      } = {
        directory,
        harnessId:
          harnessId ??
          activeSessionHarnessId ??
          resolvePendingPromptCreationHarnessRoute({
            activeTargetHarnessId: getState().activeTargetHarnessId,
            preferredHarnessId,
          }).harnessId,
      };

      if (options?.newChat) {
        const behavior = getNewChatModelBehavior();
        if (behavior === "ask") {
          payload.resetSelection = true;
        } else if (behavior === "workspace-default") {
          payload.resetSelection = true;
          const stateNow = getState();
          payload.selectedModel = resolveServerDefaultModel(
            stateNow.providers,
            stateNow.providerDefaults,
          );
          payload.selectedAgent = null;
        }
      } else if (options?.resetSelection) {
        payload.resetSelection = true;
      }

      dispatch({ type: "SET_ACTIVE_TARGET", payload });
    },
    [activeSessionHarnessId, dispatch, getState, preferredHarnessId],
  );

  const startNewChat = useCallback(async () => {
    const defaultChatDirectory = normalizeProjectPath(getState().defaultChatDirectory ?? "");
    if (!defaultChatDirectory) return;
    setActiveTarget(defaultChatDirectory, preferredHarnessId, { newChat: true });
  }, [getState, preferredHarnessId, setActiveTarget]);

  const setActiveTargetDirectory = useCallback(
    (directory: string) => {
      const harnessId =
        activeSessionHarnessId ??
        resolvePendingPromptCreationHarnessRoute({
          activeTargetHarnessId: getState().activeTargetHarnessId,
          preferredHarnessId,
        }).harnessId;
      dispatch({ type: "SET_ACTIVE_TARGET", payload: { directory, harnessId } });
    },
    [activeSessionHarnessId, dispatch, getState, preferredHarnessId],
  );

  const persistPromptBoxHarnessId = useCallback(
    (harnessId: HarnessId) => {
      storageSet(STORAGE_KEYS.HARNESS, harnessId);
      setPreferredHarnessId(harnessId);
    },
    [setPreferredHarnessId],
  );

  const setPromptBoxSelection = useCallback(
    (input: { harnessId: HarnessId; model: SelectedModel }) => {
      dispatch({ type: "SET_PROMPT_BOX_SELECTION", payload: input });
      persistPromptBoxHarnessId(input.harnessId);
    },
    [dispatch, persistPromptBoxHarnessId],
  );

  const setModelWithHarnessPersistence = useCallback(
    (model: SelectedModel | null) => {
      setModel(model);
      const stateNow = getState();
      if (model && stateNow.activeTargetDirectory && !stateNow.activeSessionId) {
        const harnessId = resolvePromptBoxHarnessId({
          activeSession: null,
          activeTargetHarnessId: stateNow.activeTargetHarnessId,
          fallbackHarnessId: preferredHarnessId,
        });
        persistPromptBoxHarnessId(harnessId);
      }
    },
    [getState, persistPromptBoxHarnessId, preferredHarnessId, setModel],
  );

  const refreshProviders = useCallback(async () => {
    const directory =
      activeResourceDirectory ??
      (loadedResourceProjectKeyRef.current
        ? parseProjectKey(loadedResourceProjectKeyRef.current).directory
        : null);
    clearResourceLoadDedupe();
    await loadServerResources(
      activeResourceHarnessId,
      directory ?? undefined,
      activeWorkspaceId ?? undefined,
      {
        force: true,
      },
    );
  }, [
    activeResourceDirectory,
    activeResourceHarnessId,
    activeWorkspaceId,
    clearResourceLoadDedupe,
    loadServerResources,
    loadedResourceProjectKeyRef,
  ]);

  const clearError = useCallback(() => {
    dispatch({ type: "SET_ERROR", payload: null });
    if (state.bootState === "error") {
      dispatch({ type: "SET_BOOT_STATE", payload: { state: "ready" } });
    }
  }, [dispatch, state.bootState]);

  const setSessionDraft = useCallback(
    (key: string, text: string) => {
      dispatch({ type: "SET_SESSION_DRAFT", payload: { key, text } });
    },
    [dispatch],
  );

  const clearSessionDraft = useCallback(
    (key: string) => {
      dispatch({ type: "CLEAR_SESSION_DRAFT", payload: key });
    },
    [dispatch],
  );

  const findFiles = useCallback(
    async (
      target: { directory?: string; workspaceId?: string; baseUrl?: string } | null,
      query: string,
    ): Promise<string[]> => {
      if (!runtime) return [];
      try {
        return await openGuiClient.files.find({
          target: target ?? {},
          query,
        });
      } catch (error) {
        console.error("[findFiles] request failed", { target, query, error });
        return [];
      }
    },
    [openGuiClient, runtime],
  );

  return {
    setDefaultChatDirectory,
    setActiveTarget,
    startNewChat,
    setActiveTargetDirectory,
    setPromptBoxSelection,
    setModelWithHarnessPersistence,
    refreshProviders,
    clearError,
    setSessionDraft,
    clearSessionDraft,
    findFiles,
  };
}
