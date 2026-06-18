import type { HarnessId } from "@/agents";
import type { HarnessDescriptor, HarnessTarget } from "@/agents/backend";
import type { InternalAgentState, QueueMode, Session } from "@/hooks/agent-state-types";
import type { OpenGuiClient } from "@/protocol/client";

/** Public interface for Pending prompt → Agent send and Queued prompt orchestration. */
export interface LocalIntentOrchestrator {
  sendPrompt: (text: string, mode?: QueueMode) => Promise<void>;
  sendCommand: (command: string, args: string) => Promise<void>;
  sendQueuedNow: (sessionId: string, promptId: string) => Promise<void>;
  ensureSession: () => Promise<string | null>;
}

export interface SessionCreationLock {
  current: boolean;
}

export interface CreateLocalIntentOrchestratorInput {
  getState: () => InternalAgentState;
  getResourceRuntime: () => HarnessDescriptor["runtime"] | undefined;
  getCurrentVariant: () => string | undefined;
  getWorkspaceBaseUrl?: (workspaceId?: string | null) => string | undefined;
  sessionsClient: OpenGuiClient["sessions"];
  createSession: (title?: string, directory?: string) => Promise<Session | null>;
  scheduleSessionMessageReconcile: (sessionId: string, projectTarget?: HarnessTarget) => void;
  requestSessionAutoName: (input: {
    sessionId: string;
    sourceText: string;
    session?: Session | null;
    force?: boolean;
  }) => void;
  dispatch: (action: unknown) => void;
  sessionCreatingRef: SessionCreationLock;
  getFallbackHarnessId: () => HarnessId;
}

export interface UseLocalIntentOrchestrationInput extends Omit<
  CreateLocalIntentOrchestratorInput,
  "sessionCreatingRef"
> {
  state: InternalAgentState;
  refreshSessionMessages: (
    sessionId: string,
    projectTarget?: { directory?: string; workspaceId?: string },
  ) => Promise<unknown>;
}

export interface UseLocalIntentOrchestrationResult extends LocalIntentOrchestrator {
  justIdledMap: Record<string, true>;
}
