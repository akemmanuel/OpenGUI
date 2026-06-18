import { DEFAULT_HARNESS_ID, type HarnessId } from "@/agents";
import type { Agent } from "@/protocol/harness-types";
import type { HarnessDescriptor, HarnessTarget } from "@/agents/backend";
import { resolveHarnessIdForSend } from "@/hooks/prompt-box-selection";
import { getSessionProjectTarget } from "@/hooks/agent-session-utils";
import type { SessionMeta } from "@/hooks/agent-state-persistence";
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

export function assertAgentSendSelection(
  selection: AgentSendSelection,
): asserts selection is AgentSendSelection & { model: SelectedModel } {
  if (!selection.model) {
    throw new Error("PROMPT_BOX_SELECTION_INCOMPLETE");
  }
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
  sessionMeta,
  sessionId,
  text,
  selection,
  activeWorkspaceId,
  getWorkspaceBaseUrl,
  mode,
  activeTargetHarnessId,
  fallbackHarnessId,
}: {
  sessions: OpenGuiClient["sessions"];
  session: Session | null | undefined;
  sessionMeta?: SessionMeta;
  sessionId: string;
  text: string;
  selection: AgentSendSelection;
  activeWorkspaceId?: string;
  getWorkspaceBaseUrl?: (workspaceId?: string | null) => string | undefined;
  mode?: QueueMode;
  activeTargetHarnessId?: HarnessId | null;
  fallbackHarnessId?: HarnessId;
}): Promise<{ projectTarget?: HarnessTarget }> {
  assertAgentSendSelection(selection);

  const rawProjectTarget = getSessionProjectTarget(session, sessionMeta) ?? undefined;
  const workspaceId = rawProjectTarget?.workspaceId ?? activeWorkspaceId;
  const baseUrl = getWorkspaceBaseUrl?.(workspaceId);
  const projectTarget =
    baseUrl || workspaceId ? { ...rawProjectTarget, workspaceId, baseUrl } : rawProjectTarget;
  const harnessId =
    resolveHarnessIdForSend({
      session,
      activeTargetHarnessId: activeTargetHarnessId ?? null,
      fallbackHarnessId: fallbackHarnessId ?? DEFAULT_HARNESS_ID,
    }) ?? undefined;

  await sessions.prompt({
    sessionId,
    text,
    model: selection.model,
    agent: selection.agent,
    variant: selection.variant,
    mode,
    target: projectTarget,
    harnessId,
  });

  return { projectTarget };
}

export async function sendCommandToAgent({
  runtime,
  session,
  sessionMeta,
  sessionId,
  command,
  args,
  selection,
}: {
  runtime: HarnessDescriptor["runtime"];
  session: Session | null | undefined;
  sessionMeta?: SessionMeta;
  sessionId: string;
  command: string;
  args: string;
  selection: AgentSendSelection;
}): Promise<{ projectTarget?: HarnessTarget }> {
  assertAgentSendSelection(selection);
  const projectTarget = getSessionProjectTarget(session, sessionMeta) ?? undefined;

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
