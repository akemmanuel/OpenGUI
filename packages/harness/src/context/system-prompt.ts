import { formatSkillsForPrompt } from "../skills/format-prompt.ts";
import type { Skill } from "../skills/types.ts";
import type { ResolvedShell } from "../tools/shell-resolution.ts";

export interface SystemPromptInput {
  projectDirectory: string;
  shell: ResolvedShell;
  skills: Skill[];
  now?: Date;
  platform?: NodeJS.Platform;
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  const now = input.now ?? new Date();
  const platform = input.platform ?? process.platform;
  const date = now.toISOString().slice(0, 10);
  const sections = [
    "You are OpenGUI's local general-purpose agent.",
    "Use the tools read, write, edit, and shell when needed. Prefer concise answers.",
    "read: read a text file (absolute or Project-relative paths).",
    "write: create or replace a text file.",
    "edit: apply an exact text replacement in a file.",
    "shell: run one non-interactive command in the Project directory; process state does not carry across calls.",
    `Current date: ${date}`,
    `Project directory: ${input.projectDirectory}`,
    `Operating system: ${platform}`,
    `Shell: ${input.shell.executable} (${input.shell.family})`,
  ];

  const skillsSection = formatSkillsForPrompt(input.skills);
  if (skillsSection) sections.push(skillsSection);

  return sections.join("\n");
}
