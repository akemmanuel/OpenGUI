import type { DurableActor } from "@opengui/harness";

export type ScopedInstructions = {
  personal: Record<string, string>;
  projects: Record<string, { text: string; teamEditors: Record<string, boolean> }>;
};

export function personalInstructionKey(actor?: DurableActor) {
  // Desktop remains account-free. API keys never inherit their issuer's preferences.
  return !actor || actor.type === "local" ? "local" : `${actor.type}:${actor.id}`;
}

export function normalizeScopedInstructions(value: unknown): ScopedInstructions {
  const result: ScopedInstructions = { personal: {}, projects: {} };
  if (!value || typeof value !== "object") return result;
  const raw = value as Partial<ScopedInstructions>;
  for (const [key, text] of Object.entries(raw.personal ?? {})) {
    if (typeof text === "string" && text.length <= 32_000) result.personal[key] = text;
  }
  for (const [directory, project] of Object.entries(raw.projects ?? {})) {
    if (!project || typeof project.text !== "string" || project.text.length > 32_000) continue;
    result.projects[directory] = {
      text: project.text,
      teamEditors: Object.fromEntries(
        Object.entries(project.teamEditors ?? {}).filter(
          ([, allowed]) => typeof allowed === "boolean",
        ),
      ),
    };
  }
  return result;
}

export function composeInstructions(host: string, project: string, personal: string) {
  const sections = [
    host && `Host instructions:\n${host}`,
    project && `Shared project instructions:\n${project}`,
    personal && `Personal preferences (for the person requesting this turn):\n${personal}`,
  ].filter(Boolean);
  if (!sections.length) return "";
  return [
    "Apply all applicable instructions. On conflict, Host instructions take precedence over project instructions; project instructions take precedence over personal preferences. These instructions do not grant tool capabilities or access permissions.",
    ...sections,
  ].join("\n\n");
}
