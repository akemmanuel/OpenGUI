import type { InternalAgentState } from "@/hooks/agent-state-types";
import type { Action } from "@/hooks/agent-reducer-types";
import {
  isQueuePresentationAction,
  mergeQueuePresentationSlice,
  pickQueuePresentationSlice,
  reduceQueuePresentation,
} from "@/hooks/agent-reducer-queue-slice";
import {
  isWorkspaceReducerAction,
  reduceWorkspaceSlice,
} from "@/hooks/agent-reducer-workspace-slice";
import {
  isSessionActivityReducerAction,
  reduceSessionActivitySlice,
} from "@/hooks/agent-reducer-session-activity-slice";

export type { Action } from "@/hooks/agent-reducer-types";
export { mergeProjectBackendSessions } from "@/hooks/agent-session-index-merge";

export function reducer(state: InternalAgentState, action: Action): InternalAgentState {
  if (isQueuePresentationAction(action)) {
    return mergeQueuePresentationSlice(
      state,
      reduceQueuePresentation(pickQueuePresentationSlice(state), action),
    );
  }

  if (isWorkspaceReducerAction(action)) {
    return reduceWorkspaceSlice(state, action);
  }

  if (isSessionActivityReducerAction(action)) {
    return reduceSessionActivitySlice(state, action);
  }

  return state;
}
