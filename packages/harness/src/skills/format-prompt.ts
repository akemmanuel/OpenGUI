import type { Skill } from "./types.ts";

/**
 * Format skills for the system prompt using Agent Skills progressive disclosure.
 * Skills with disable-model-invocation are omitted.
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";

  const lines = [
    "Skills: when a description matches, read that SKILL.md before proceeding. Resolve relative paths from the skill directory.",
  ];

  for (const skill of visible) {
    const description = skill.description.replace(/\s+/gu, " ").trim();
    lines.push(`- ${skill.name}: ${description} (${skill.filePath})`);
  }

  return lines.join("\n");
}
