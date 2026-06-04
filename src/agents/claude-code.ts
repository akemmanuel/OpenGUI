import type { NativeBackendEvent } from "@/types/electron";
import type { HarnessCapabilities, HarnessEvent } from "./backend.ts";
import { normalizeTaggedBackendEvent } from "./shared.ts";

export const CLAUDE_CODE_CAPABILITIES: HarnessCapabilities = {
  sessions: true,
  streaming: true,
  messagePaging: true,
  models: true,
  agents: false,
  commands: true,
  compact: true,
  fork: true,
  revert: false,
  permissions: true,
  questions: false,
  providerAuth: false,
  mcp: false,
  skills: false,
  config: false,
  localServer: false,
};

export const CLAUDE_CODE_WORKSPACE = {
  kind: "local-cli",
  fields: {
    serverUrl: false,
    username: false,
    password: false,
    directory: true,
  },
} as const;

export function normalizeClaudeCodeEvent(event: NativeBackendEvent): HarnessEvent | null {
  return normalizeTaggedBackendEvent("claude-code", event, "claude-code:event");
}
