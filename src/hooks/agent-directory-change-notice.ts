import type { SessionMeta } from "@/hooks/agent-state-persistence";
import type { Session } from "@/hooks/agent-state-types";

export interface DirectoryChangePromptPlan {
  text: string;
  metaPatch?: Partial<SessionMeta>;
}

export function planDirectoryChangePrompt(input: {
  text: string;
  session?: Session;
  meta?: SessionMeta;
}): DirectoryChangePromptPlan {
  return { text: input.text };
}
