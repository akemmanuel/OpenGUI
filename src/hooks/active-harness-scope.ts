import type { AgentBackendId } from "@/agents";
import type { AgentBackendDescriptor } from "@/agents/backend";
import {
  resolveActiveResourceHarnessRoute,
  type HarnessRoute,
} from "@/hooks/agent-harness-routing";
import { getSessionDirectory } from "@/hooks/agent-session-utils";
import type { Session } from "@/hooks/agent-state-types";
import type { OpenGuiClient } from "@/protocol/client";

export interface ActiveHarnessScope {
  route: HarnessRoute;
  harnessId: AgentBackendId;
  directory: string | null;
  backend: AgentBackendDescriptor | undefined;
  runtime: AgentBackendDescriptor["runtime"] | undefined;
  workspaceProfile: AgentBackendDescriptor["workspace"] | undefined;
}

export function resolveActiveHarnessScope({
  activeSession,
  activeTargetDirectory,
  activeTargetBackendId,
  workspaceDirectory,
  preferredBackendId,
  backendsById,
  openGuiClient,
}: {
  activeSession: Session | null | undefined;
  activeTargetDirectory: string | null;
  activeTargetBackendId: AgentBackendId | null;
  workspaceDirectory: string | null;
  preferredBackendId: AgentBackendId;
  backendsById: Partial<Record<AgentBackendId, AgentBackendDescriptor>>;
  openGuiClient: OpenGuiClient;
}): ActiveHarnessScope {
  const route = resolveActiveResourceHarnessRoute({
    activeSession,
    activeTargetBackendId,
    preferredBackendId,
  });
  const directory =
    getSessionDirectory(activeSession) ?? activeTargetDirectory ?? workspaceDirectory;
  const backend = backendsById[route.harnessId] ?? openGuiClient.agentBackends.get(route.harnessId);

  return {
    route,
    harnessId: route.harnessId,
    directory,
    backend,
    runtime: backend?.runtime,
    workspaceProfile: backend?.workspace,
  };
}
