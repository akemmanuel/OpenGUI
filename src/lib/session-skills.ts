import { normalizeProjectPath } from "@/lib/path";

export type SkillToggleItem = {
  name: string;
  manual: boolean;
};

/** Auto skills start enabled; manual skills start disabled. */
export function defaultEnabledSkillNames(skills: readonly SkillToggleItem[]): string[] {
  return skills.filter((skill) => !skill.manual).map((skill) => skill.name);
}

/** Stable key for session-scoped skill selection. */
export function sessionSkillsKey(
  sessionId: string | null | undefined,
  directory: string | null | undefined,
): string | null {
  if (sessionId) return `session:${sessionId}`;
  if (directory) return `pending:${normalizeProjectPath(directory)}`;
  return null;
}
