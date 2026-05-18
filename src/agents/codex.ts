import type { NativeBackendEvent } from "@/types/electron";
import type { AgentBackendCapabilities, AgentBackendEvent } from "./backend";
import { normalizeTaggedBackendEvent } from "./shared";

export const CODEX_CAPABILITIES: AgentBackendCapabilities = {
  sessions: true,
  streaming: true,
  messagePaging: false,
  images: true,
  models: true,
  agents: false,
  commands: false,
  compact: false,
  fork: false,
  revert: false,
  permissions: false,
  questions: false,
  providerAuth: false,
  mcp: false,
  skills: false,
  config: false,
  localServer: false,
};

export const CODEX_WORKSPACE = {
  kind: "local-cli",
  fields: {
    serverUrl: false,
    username: false,
    password: false,
    directory: true,
  },
} as const;

export function normalizeCodexEvent(event: NativeBackendEvent): AgentBackendEvent | null {
  return normalizeTaggedBackendEvent("codex", event, "codex:event");
}
