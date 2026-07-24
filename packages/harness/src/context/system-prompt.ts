import { formatSkillsForPrompt } from "../skills/format-prompt.ts";
import type { ModelToolName } from "../models/transport.ts";
import type { Skill } from "../skills/types.ts";
import type { ResolvedShell } from "../tools/shell-resolution.ts";

export interface SystemPromptInput {
  projectDirectory: string;
  shell?: ResolvedShell;
  tools?: readonly ModelToolName[];
  skills: Skill[];
  now?: Date;
  platform?: NodeJS.Platform;
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  const now = input.now ?? new Date();
  const platform = input.platform ?? process.platform;
  const date = now.toISOString().slice(0, 10);
  const tools =
    input.tools ?? (["read", "write", "edit", ...(input.shell ? ["shell"] : [])] as const);
  const toolNames = tools.join(", ").replace(/, ([^,]*)$/u, ", and $1");
  const sections = [
    "You are OpenGUI's local general-purpose agent.",
    `Use the tools ${toolNames} when needed. Prefer concise answers.`,
    ...(tools.includes("read")
      ? ["read: read a text file (absolute or Project-relative paths)."]
      : []),
    ...(tools.includes("write") ? ["write: create or replace a text file."] : []),
    ...(tools.includes("edit") ? ["edit: apply an exact text replacement in a file."] : []),
    ...(tools.includes("shell")
      ? [
          "shell: run one non-interactive command in the Project directory; process state does not carry across calls.",
        ]
      : []),
    `Current date: ${date}`,
    `Project directory: ${input.projectDirectory}`,
    `Operating system: ${platform}`,
  ];

  if (tools.includes("shell") && input.shell) {
    sections.push(`Shell: ${input.shell.executable} (${input.shell.family})`);
  }

  const skillsSection = formatSkillsForPrompt(input.skills);
  if (skillsSection) sections.push(skillsSection);

  return sections.join("\n");
}
