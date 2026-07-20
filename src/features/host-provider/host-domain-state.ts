import { useMemo, useReducer, type Dispatch, type SetStateAction } from "react";
import type { Provider } from "@/protocol/agent-types";
import type { ReasoningEffort } from "@/protocol/host-types";
import type { Session } from "@/hooks/agent-state-types";
import type { ProjectMetaMap, SessionMetaMap } from "@/lib/persistence";
import type { SelectedModel } from "@opengui/protocol";
import type { Workspace } from "@/types/workspace";

export type HostBootState = "idle" | "checking-server" | "starting-server" | "ready" | "error";
export type HostQueuedPrompt = { id: string; text: string; mode: "queue" };

export interface WorkspaceSlice {
  workspaces: Workspace[];
  activeWorkspaceId: string;
}

export interface ProjectSlice {
  projects: string[];
  activeTargetDirectory: string | null;
  projectMeta: ProjectMetaMap;
}

export interface SessionSlice {
  sessions: Session[];
  activeSessionId: string | null;
  busySessionIds: Set<string>;
  queuedPrompts: Record<string, HostQueuedPrompt[]>;
  sessionDrafts: Record<string, string>;
  sessionMeta: SessionMetaMap;
}

export interface ModelSlice {
  providers: Provider[];
  selectedModel: SelectedModel | null;
  reasoningEffort: ReasoningEffort;
}

export interface TransportSlice {
  bootState: HostBootState;
  bootError: string | null;
  lastError: string | null;
}

type SliceAction<S> = { [K in keyof S]: { key: K; value: SetStateAction<S[K]> } }[keyof S];

export function reduceHostSlice<S>(state: S, action: SliceAction<S>): S {
  const current = state[action.key];
  const value =
    typeof action.value === "function"
      ? (action.value as (previous: typeof current) => typeof current)(current)
      : action.value;
  return Object.is(current, value) ? state : { ...state, [action.key]: value };
}

export function createHostSliceSetter<S extends object>(
  dispatch: (action: SliceAction<S>) => void,
) {
  const setters = new Map<keyof S, Dispatch<SetStateAction<S[keyof S]>>>();

  return <K extends keyof S>(key: K): Dispatch<SetStateAction<S[K]>> => {
    const existing = setters.get(key);
    if (existing) return existing as Dispatch<SetStateAction<S[K]>>;

    const setValue: Dispatch<SetStateAction<S[K]>> = (value) =>
      dispatch({ key, value } as SliceAction<S>);
    setters.set(key, setValue as Dispatch<SetStateAction<S[keyof S]>>);
    return setValue;
  };
}

/**
 * A small reducer seam used by each Host domain. Setters deliberately match React's
 * useState interface so orchestration code does not need to know how a slice is stored.
 */
export function useHostSlice<S extends object>(initial: () => S) {
  const [state, dispatch] = useReducer(reduceHostSlice<S>, undefined, initial);
  const setter = useMemo(() => createHostSliceSetter<S>(dispatch), [dispatch]);
  return { state, setter } as const;
}
