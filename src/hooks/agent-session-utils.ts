import { normalizeProjectPath } from "@/lib/utils";
import type { AgentBackendId } from "@/agents";
import type { ProjectMetaMap } from "@/hooks/agent-state-persistence";
import type { MessageEntry, Session } from "@/hooks/use-agent-impl-core";
import type { SelectedModel } from "@/types/electron";

const PROJECT_KEY_SEPARATOR = "\u0000";

export function makeProjectKey(workspaceId: string | null | undefined, directory: string) {
  return `${workspaceId ?? ""}${PROJECT_KEY_SEPARATOR}${normalizeProjectPath(directory)}`;
}

export function parseProjectKey(projectKey: string) {
  const idx = projectKey.indexOf(PROJECT_KEY_SEPARATOR);
  if (idx < 0) {
    return { workspaceId: "", directory: projectKey };
  }
  return {
    workspaceId: projectKey.slice(0, idx),
    directory: projectKey.slice(idx + PROJECT_KEY_SEPARATOR.length),
  };
}

export function getSessionDirectory(session: Session | undefined | null) {
  if (!session) return null;
  return session._projectDir ?? session.directory ?? null;
}

export function getSessionWorkspaceId(session: Session | undefined | null) {
  if (!session) return null;
  return session._workspaceId ?? null;
}

export function getSessionProjectTarget(session: Session | undefined | null) {
  const directory = getSessionDirectory(session);
  if (!directory) return null;
  return {
    directory,
    workspaceId: getSessionWorkspaceId(session) ?? undefined,
  };
}

export function getSessionBackendId(session: Session | undefined | null): AgentBackendId | null {
  return session?._backendId ?? null;
}

export function getSessionSelectedModel(session: Session | undefined | null): SelectedModel | null {
  const model = session?.model;
  if (!model?.providerID || !model.id) return null;
  return { providerID: model.providerID, modelID: model.id };
}

export function getSessionSelectedVariant(session: Session | undefined | null): string | null {
  const variant = session?.model?.variant;
  return typeof variant === "string" && variant.length > 0 ? variant : null;
}

export function getSessionSelectedAgent(session: Session | undefined | null): string | null {
  const agent = session?.agent;
  return typeof agent === "string" && agent.length > 0 ? agent : null;
}

export function shouldAutoNameSession(session: Session | undefined | null) {
  const title = session?.title?.trim();
  return !title || title.toLowerCase() === "untitled";
}

export function getSessionSortTime(session: Session): number {
  return session.time.updated ?? session.time.created ?? 0;
}

export function sortSessionsNewestFirst(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    const byUpdated = getSessionSortTime(b) - getSessionSortTime(a);
    if (byUpdated !== 0) return byUpdated;
    return b.id.localeCompare(a.id);
  });
}

export function isHiddenProject(
  projectMeta: ProjectMetaMap,
  workspaceId: string | null | undefined,
  directory: string,
): boolean {
  return projectMeta[makeProjectKey(workspaceId, directory)]?.hidden === true;
}

function extractMessageText(entry: MessageEntry): string {
  const segments: string[] = [];
  for (const part of entry.parts) {
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      segments.push(part.text.trim());
      continue;
    }
    if (part.type === "tool") {
      const toolName = part.tool || "tool";
      const status = part.state?.status || "completed";
      segments.push(`[tool:${toolName} ${status}]`);
    }
  }
  return segments.join("\n\n").trim();
}

export function buildSessionMigrationPrompt(input: {
  entries: MessageEntry[];
  sourceDirectory: string;
  targetDirectory: string;
  title?: string;
}): string {
  const transcript = input.entries
    .map((entry) => {
      const text = extractMessageText(entry);
      if (!text) return null;
      const role = entry.info.role === "assistant" ? "Assistant" : "User";
      return `${role}:\n${text}`;
    })
    .filter((value): value is string => Boolean(value));
  const MAX_MESSAGES = 12;
  const selectedTranscript = transcript.slice(-MAX_MESSAGES);
  const trimmedCount = transcript.length - selectedTranscript.length;
  const transcriptBlock = selectedTranscript.join("\n\n---\n\n").slice(0, 12000);
  const trimNotice =
    trimmedCount > 0 ? `Earlier conversation omitted: ${trimmedCount} message(s).\n\n` : "";
  return [
    "INTERNAL_SESSION_MOVE_CONTEXT",
    `This conversation was moved from \`${input.sourceDirectory}\` to \`${input.targetDirectory}\`.`,
    "Work in the target directory from now on and treat the following transcript as prior context.",
    "Do not ask the user to confirm the directory and do not mention this migration unless the user explicitly asks.",
    "Do not perform a visible directory-check response for this migration step. Simply continue working in the new directory on the next real user message.",
    input.title ? `Original title: ${input.title}` : null,
    trimNotice ? trimNotice.trimEnd() : null,
    "Transcript:",
    transcriptBlock || "No prior transcript available.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
