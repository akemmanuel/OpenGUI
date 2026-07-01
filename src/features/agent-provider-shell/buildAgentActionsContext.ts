import { useMemo } from "react";
import type { ActionsContextValue } from "@/hooks/agent-contexts";

export function useAgentActionsContextValue(
  actions: ActionsContextValue,
  deps: readonly unknown[],
): ActionsContextValue {
  return useMemo(() => actions, deps);
}
