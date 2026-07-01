import { useCallback, useRef, type Dispatch } from "react";
import type { HarnessId } from "@/agents";
import { isModelAvailable, resolveAvailableAgent } from "@/hooks/agent-model-selection";
import type { Action } from "@/hooks/agent-reducer";
import type { InternalAgentState } from "@/hooks/agent-state-types";
import {
  getVariantSelectionsForWorkspace,
  persistVariantSelectionsForWorkspace,
} from "@/hooks/agent-state-persistence";
import { getSessionSelectedAgent, makeProjectKey } from "@/hooks/agent-session-utils";
import { updateVariantSelections, variantKey } from "@/hooks/use-agent-variant-core";
import { STORAGE_KEYS } from "@/lib/constants";
import { ensureHarnessResourceCatalog } from "@/lib/ensure-harness-resource-catalog";
import { storageGet } from "@/lib/safe-storage";
import { getErrorMessage } from "@/lib/utils";
import type { OpenGuiClient } from "@/protocol/client";

export function useAgentResourceCatalog(input: {
  openGuiClient: OpenGuiClient;
  dispatch: Dispatch<Action>;
  getState: () => InternalAgentState;
}) {
  const { openGuiClient, dispatch, getState } = input;
  const loadedResourceProjectKeyRef = useRef<string | null>(null);
  const loadedResourceHarnessIdRef = useRef<HarnessId | null>(null);
  const resourceLoadRequestIdRef = useRef(0);

  const clearResourceLoadDedupe = useCallback(() => {
    loadedResourceHarnessIdRef.current = null;
    loadedResourceProjectKeyRef.current = null;
  }, []);

  const loadServerResources = useCallback(
    async (
      harnessId: HarnessId,
      directory?: string | null,
      workspaceId?: string | null,
      options?: { force?: boolean },
    ) => {
      const targetDirectory = directory?.trim() || undefined;
      const targetWorkspaceId = workspaceId?.trim() || undefined;
      const state = getState();
      const targetWorkspace = targetWorkspaceId
        ? state.workspaces.find((workspace) => workspace.id === targetWorkspaceId)
        : null;
      const projectKey = targetDirectory ? makeProjectKey(targetWorkspaceId, targetDirectory) : "";
      const loadedProjectKeyForRef = targetDirectory ? projectKey : null;
      if (
        !options?.force &&
        loadedResourceHarnessIdRef.current === harnessId &&
        loadedResourceProjectKeyRef.current === loadedProjectKeyForRef
      ) {
        return;
      }
      const requestId = ++resourceLoadRequestIdRef.current;
      try {
        const { providersData, agentsData, commandsData } = await ensureHarnessResourceCatalog({
          harnessId,
          target: {
            workspaceId: targetWorkspaceId ?? state.activeWorkspaceId,
            directory: targetDirectory ?? null,
            baseUrl: targetWorkspace?.isLocal ? undefined : targetWorkspace?.serverUrl,
            authToken: targetWorkspace?.isLocal ? undefined : targetWorkspace?.authToken,
          },
          client: openGuiClient,
          force: options?.force,
        });

        if (requestId !== resourceLoadRequestIdRef.current) {
          return;
        }

        loadedResourceProjectKeyRef.current = loadedProjectKeyForRef;
        loadedResourceHarnessIdRef.current = harnessId;

        const currentSelection = getState().selectedModel;
        const nextSelection = isModelAvailable(providersData.providers, currentSelection)
          ? currentSelection
          : null;
        dispatch({
          type: "SET_SELECTED_MODEL",
          payload: nextSelection ?? null,
        });

        dispatch({ type: "SET_AGENTS", payload: agentsData });
        const activeSessionId = getState().activeSessionId;
        const activeSession = activeSessionId
          ? getState().sessions.find((session) => session.id === activeSessionId)
          : null;
        const activeSessionAgent = getSessionSelectedAgent(activeSession);
        const activeSessionMeta = activeSessionId
          ? getState().sessionMeta[activeSessionId]
          : undefined;
        const nextAgent = resolveAvailableAgent({
          agents: agentsData,
          sessionAgent: activeSessionAgent ?? activeSessionMeta?.selectedAgent,
          hasSessionAgent: Boolean(
            activeSessionAgent ||
            (activeSessionMeta && Object.hasOwn(activeSessionMeta, "selectedAgent")),
          ),
          workspaceAgent: storageGet(STORAGE_KEYS.SELECTED_AGENT),
        });
        dispatch({ type: "SET_SELECTED_AGENT", payload: nextAgent });

        let nextVariantSelections = getVariantSelectionsForWorkspace(
          targetWorkspaceId ?? getState().activeWorkspaceId,
        );
        if (
          activeSessionMeta &&
          Object.hasOwn(activeSessionMeta, "selectedVariant") &&
          nextSelection
        ) {
          const key = variantKey(nextSelection.providerID, nextSelection.modelID);
          const desiredVariant = activeSessionMeta.selectedVariant ?? undefined;
          if (nextVariantSelections[key] !== desiredVariant) {
            nextVariantSelections = updateVariantSelections(
              nextVariantSelections,
              key,
              desiredVariant,
            );
          }
        }
        if (nextVariantSelections !== getState().variantSelections) {
          persistVariantSelectionsForWorkspace(
            targetWorkspaceId ?? getState().activeWorkspaceId,
            nextVariantSelections,
          );
        }

        dispatch({
          type: "SET_WORKSPACE_RESOURCES",
          payload: {
            workspaceId: targetWorkspaceId ?? getState().activeWorkspaceId,
            harnessId,
            projectKey: targetDirectory ? projectKey : null,
            providersData,
            agentsData,
            commandsData,
            variantSelections: nextVariantSelections,
          },
        });
      } catch (error) {
        if (requestId !== resourceLoadRequestIdRef.current) return;
        dispatch({
          type: "SET_ERROR",
          payload: getErrorMessage(error),
        });
      }
    },
    [dispatch, getState, openGuiClient],
  );

  return {
    loadServerResources,
    loadedResourceProjectKeyRef,
    loadedResourceHarnessIdRef,
    clearResourceLoadDedupe,
  };
}
