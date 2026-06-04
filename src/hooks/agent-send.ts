import type { Agent } from "@opencode-ai/sdk/v2/client";
import type { AgentBackendDescriptor, AgentBackendTarget } from "@/agents/backend";
import { resolveSessionHarnessRoute } from "@/hooks/agent-harness-routing";
import { getSessionProjectTarget } from "@/hooks/agent-session-utils";
import type { Session } from "@/hooks/agent-state-types";
import type { VariantSelections } from "@/hooks/use-agent-variant-core";
import { resolveVariant } from "@/hooks/use-agent-variant-core";
import type { OpenGuiClient } from "@/protocol/client";
import type { QueueMode } from "@/lib/session-drafts";
import type { SelectedModel } from "@/types/electron";

export interface AgentSendSelectionSnapshot {
  selectedModel: SelectedModel | null;
  selectedAgent: string | null;
  variantSelections: VariantSelections;
  agents: Agent[];
}

export interface AgentSendSelection {
  model?: SelectedModel;
  agent?: string;
  variant?: string;
}

export function resolveAgentSendSelection(
  snapshot: AgentSendSelectionSnapshot,
  overrides?: {
    model?: SelectedModel;
    agent?: string;
    variant?: string;
  },
): AgentSendSelection {
  const model = overrides?.model ?? snapshot.selectedModel ?? undefined;
  const agent = overrides?.agent ?? snapshot.selectedAgent ?? undefined;
  const variant =
    overrides?.variant ??
    resolveVariant(model ?? null, snapshot.variantSelections, snapshot.agents, agent ?? null);

  return { model, agent, variant };
}

export async function sendPromptToAgent({
  sessions,
  session,
  sessionId,
  text,
  selection,
  activeWorkspaceId,
  getWorkspaceBaseUrl,
  mode,
}: {
  sessions: OpenGuiClient["sessions"];
  session: Session | null | undefined;
  sessionId: string;
  text: string;
  selection: AgentSendSelection;
  activeWorkspaceId?: string;
  getWorkspaceBaseUrl?: (workspaceId?: string | null) => string | undefined;
  mode?: QueueMode;
}): Promise<{ projectTarget?: AgentBackendTarget }> {
  const rawProjectTarget = getSessionProjectTarget(session) ?? undefined;
  const workspaceId = rawProjectTarget?.workspaceId ?? activeWorkspaceId;
  const baseUrl = getWorkspaceBaseUrl?.(workspaceId);
  const projectTarget =
    baseUrl || workspaceId ? { ...rawProjectTarget, workspaceId, baseUrl } : rawProjectTarget;
  const backendId = resolveSessionHarnessRoute(session).harnessId ?? undefined;

  await sessions.prompt({
    sessionId,
    text,
    model: selection.model,
    agent: selection.agent,
    variant: selection.variant,
    mode,
    target: projectTarget,
    backendId,
  });

  return { projectTarget };
}

export async function sendCommandToAgent({
  runtime,
  session,
  sessionId,
  command,
  args,
  selection,
}: {
  runtime: AgentBackendDescriptor["runtime"];
  session: Session | null | undefined;
  sessionId: string;
  command: string;
  args: string;
  selection: AgentSendSelection;
}): Promise<{ projectTarget?: AgentBackendTarget }> {
  const projectTarget = getSessionProjectTarget(session) ?? undefined;

  await runtime.sendCommand({
    sessionId,
    command,
    args,
    model: selection.model,
    agent: selection.agent,
    variant: selection.variant,
    directory: projectTarget?.directory,
    workspaceId: projectTarget?.workspaceId,
  });

  return { projectTarget };
}
