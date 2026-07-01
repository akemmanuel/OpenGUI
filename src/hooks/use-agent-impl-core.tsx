/**
 * Central React context + hook for Harness state.
 *
 * Provides connection lifecycle, session management, messages,
 * variant selection, and real-time Harness event handling to entire
 * component tree.
 */

import type { ReactNode } from "react";
import type { InternalAgentState } from "@/hooks/agent-state-types";
import { ActiveSessionTranscriptProvider } from "@/features/session-transcript/active-session-transcript-provider";
import { InternalAgentProviderBody } from "@/features/agent-provider-shell";

export { LOCAL_WORKSPACE_ID, NOTIFICATIONS_ENABLED_KEY } from "@/hooks/agent-state-persistence";
export { resolveServerDefaultModel } from "@/hooks/agent-model-selection";

function InternalAgentProvider({
  children,
  detachedProject,
}: {
  children: ReactNode;
  detachedProject?: string;
}) {
  return (
    <ActiveSessionTranscriptProvider>
      <InternalAgentProviderBody detachedProject={detachedProject}>
        {children}
      </InternalAgentProviderBody>
    </ActiveSessionTranscriptProvider>
  );
}

export const HarnessProvider = InternalAgentProvider;
export type HarnessState = InternalAgentState;
