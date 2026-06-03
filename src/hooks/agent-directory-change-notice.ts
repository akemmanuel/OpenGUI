import type { SessionMeta } from "@/hooks/agent-state-persistence";
import type { Session } from "@/hooks/agent-state-types";
import { normalizeProjectPath } from "@/lib/utils";

export interface DirectoryChangePromptPlan {
  text: string;
  metaPatch?: Partial<SessionMeta>;
}

export function planDirectoryChangePrompt(input: {
  text: string;
  session?: Session;
  meta?: SessionMeta;
}): DirectoryChangePromptPlan {
  const targetDirectory = input.meta?.assignedProjectDir
    ? normalizeProjectPath(input.meta.assignedProjectDir)
    : null;
  if (!input.meta?.pendingDirectoryChangeNotice || !targetDirectory) return { text: input.text };

  const sourceDirectory = normalizeProjectPath(
    input.meta.assignedProjectSourceDir ??
      input.session?._projectDir ??
      input.session?.directory ??
      "",
  );
  const notice = [
    "<SYSTEM-APPEND>",
    `OpenGUI has reassigned this conversation from project \`${sourceDirectory || "unknown"}\` to project \`${targetDirectory}\`.`,
    "Important: the native backend session may still have its original working directory.",
    `From now on, treat \`${targetDirectory}\` as the intended project root.`,
    `When using tools, file paths, search commands, shell commands, or edits, explicitly target \`${targetDirectory}\` unless the user asks otherwise.`,
    "Do not assume relative paths resolve against the intended project root; use absolute paths when needed.",
    "Do not mention this implementation detail to the user unless it becomes relevant to explain tool behavior.",
    "</SYSTEM-APPEND>",
  ].join("\n");

  return {
    text: `${notice}\n\n${input.text}`,
    metaPatch: {
      pendingDirectoryChangeNotice: false,
      hideSystemAppendBlocks: true,
    },
  };
}
