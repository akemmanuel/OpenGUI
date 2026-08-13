import { formatSkillsForPrompt } from "../skills/format-prompt.ts";
import type { ModelToolName } from "../models/transport.ts";
import type { Skill } from "../skills/types.ts";
import type { ResolvedShell } from "../tools/shell-resolution.ts";

export interface SystemPromptInput {
  projectDirectory: string;
  shell?: ResolvedShell;
  tools?: readonly ModelToolName[];
  skills: Skill[];
  /** Host-wide house rules appended after the product prompt. */
  customInstructions?: string;
  now?: Date;
  platform?: NodeJS.Platform;
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  const now = input.now ?? new Date();
  const platform = input.platform ?? process.platform;
  const date = now.toISOString().slice(0, 10);
  const tools =
    input.tools ?? (["read", "write", "edit", ...(input.shell ? ["shell"] : [])] as const);
  const sections = [
    "You are OpenGUI's local general-purpose agent.",
    `Current date: ${date}`,
    `Project directory: ${input.projectDirectory}`,
    `Operating system: ${platform}`,
  ];

  // Only advertise the shell binary when shell is actually available this turn.
  if (tools.includes("shell") && input.shell) {
    sections.push(`Shell: ${input.shell.executable} (${input.shell.family})`);
  }

  const skillsSection = formatSkillsForPrompt(input.skills);
  if (skillsSection) sections.push(skillsSection);

  const customInstructions = input.customInstructions?.trim();
  if (customInstructions) {
    sections.push(`Custom instructions:\n${customInstructions}`);
  }

  return sections.join("\n");
}
