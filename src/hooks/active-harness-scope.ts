import type { HarnessId } from "@/agents";
import type { HarnessDescriptor } from "@/agents/backend";
import {
  resolveActiveResourceHarnessRoute,
  type HarnessRoute,
} from "@/hooks/agent-harness-routing";
import { getSessionDirectory } from "@/hooks/agent-session-utils";
import type { Session } from "@/hooks/agent-state-types";
import type { OpenGuiClient } from "@/protocol/client";

export interface ActiveHarnessScope {
  route: HarnessRoute;
  harnessId: HarnessId;
  directory: string | null;
  harness: HarnessDescriptor | undefined;
  runtime: HarnessDescriptor["runtime"] | undefined;
  connectionProfile: HarnessDescriptor["connection"] | undefined;
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
  activeTargetBackendId: HarnessId | null;
  workspaceDirectory: string | null;
  preferredBackendId: HarnessId;
  backendsById: Partial<Record<HarnessId, HarnessDescriptor>>;
  openGuiClient: OpenGuiClient;
}): ActiveHarnessScope {
  const route = resolveActiveResourceHarnessRoute({
    activeSession,
    activeTargetBackendId,
    preferredBackendId,
  });
  const directory =
    getSessionDirectory(activeSession) ?? activeTargetDirectory ?? workspaceDirectory;
  const harness = backendsById[route.harnessId] ?? openGuiClient.harnesses.get(route.harnessId);

  return {
    route,
    harnessId: route.harnessId,
    directory,
    harness,
    runtime: harness?.runtime,
    connectionProfile: harness?.connection,
  };
}
