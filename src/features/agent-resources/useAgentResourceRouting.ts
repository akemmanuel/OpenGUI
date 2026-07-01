import { useEffect, useMemo } from "react";
import type { Dispatch } from "react";
import type { HarnessId } from "@/agents";
import { resolveActiveHarnessScope } from "@/hooks/active-harness-scope";
import type { Action } from "@/hooks/agent-reducer";
import type { InternalAgentState, Session } from "@/hooks/agent-state-types";
import type { OpenGuiClient } from "@/protocol/client";

type HarnessBackend = ReturnType<OpenGuiClient["harnesses"]["list"]>[number];

export function useAgentResourceRouting(input: {
  state: InternalAgentState;
  dispatch: Dispatch<Action>;
  activeSession: Session | null;
  workspaceDirectory: string | null;
  preferredHarnessId: HarnessId;
  backendsById: Record<HarnessId, HarnessBackend>;
  openGuiClient: OpenGuiClient;
  detachedProject?: string;
}) {
  const {
    state,
    dispatch,
    activeSession,
    workspaceDirectory,
    preferredHarnessId,
    backendsById,
    openGuiClient,
    detachedProject,
  } = input;

  useEffect(() => {
    if (detachedProject) return;
    if (state.activeSessionId || state.activeTargetDirectory) return;
    if (!state.defaultChatDirectory) return;
    dispatch({
      type: "SET_ACTIVE_TARGET",
      payload: {
        directory: state.defaultChatDirectory,
        harnessId: preferredHarnessId,
      },
    });
  }, [
    detachedProject,
    dispatch,
    preferredHarnessId,
    state.activeSessionId,
    state.activeTargetDirectory,
    state.defaultChatDirectory,
  ]);

  const scope = useMemo(
    () =>
      resolveActiveHarnessScope({
        activeSession,
        activeTargetDirectory: state.activeTargetDirectory,
        activeTargetHarnessId: state.activeTargetHarnessId,
        workspaceDirectory,
        preferredHarnessId,
        backendsById,
        openGuiClient,
      }),
    [
      activeSession,
      backendsById,
      openGuiClient,
      preferredHarnessId,
      state.activeTargetDirectory,
      state.activeTargetHarnessId,
      workspaceDirectory,
    ],
  );

  const activeResourceHarnessId = scope.harnessId;
  const activeResourceDirectory = scope.directory;

  useEffect(() => {
    if (!state.activeTargetHarnessId) return;
    if (backendsById[state.activeTargetHarnessId]) return;
    if (!activeResourceDirectory || !backendsById[preferredHarnessId]) return;
    dispatch({
      type: "SET_ACTIVE_TARGET",
      payload: { directory: activeResourceDirectory, harnessId: preferredHarnessId },
    });
  }, [
    activeResourceDirectory,
    backendsById,
    dispatch,
    preferredHarnessId,
    state.activeTargetHarnessId,
  ]);

  return {
    activeResourceHarnessId,
    activeResourceDirectory,
    resourceHarness: scope.harness,
    runtime: scope.runtime,
  };
}
