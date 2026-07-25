import type { Skill } from "./types.ts";

function skillCatalogLine(skill: Skill): string {
  const description = skill.description.replace(/\s+/gu, " ").trim();
  return `- ${skill.name}: ${description} (${skill.filePath})`;
}

/**
 * Format skills for the system prompt using Agent Skills progressive disclosure.
 * Callers pass the already-selected catalog for this turn.
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) {
    return "Skills: no skills are enabled for this Session. Do not discover, load, or follow any SKILL.md files.";
  }

  const lines = [
    "Skills: this is the complete skill catalog for this Session. When a description matches, read that SKILL.md before proceeding. Resolve relative paths from the skill directory. Do not discover, load, or follow any other SKILL.md files.",
  ];

  for (const skill of skills) {
    lines.push(skillCatalogLine(skill));
  }

  return lines.join("\n");
}

/** Resolve skill names against the discovered skill set, preserving request order. */
export function resolveSkillsByName(skills: Skill[], names: readonly string[]): Skill[] {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const resolved: Skill[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    const skill = byName.get(name);
    if (!skill) continue;
    seen.add(name);
    resolved.push(skill);
  }
  return resolved;
}

/**
 * Choose which discovered skills enter the model catalog for a turn.
 * - `enabledNames === undefined`: default auto catalog (non-manual only)
 * - otherwise: exact allowlist, including manual skills the user enabled
 */
export function selectSkillsForPrompt(
  skills: Skill[],
  enabledNames: readonly string[] | undefined,
): Skill[] {
  if (enabledNames === undefined) {
    return skills.filter((skill) => !skill.disableModelInvocation);
  }
  return resolveSkillsByName(skills, enabledNames);
}
