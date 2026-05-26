import type { NativeBackendEvent } from "@/types/electron";
import type { AgentBackendCapabilities, AgentBackendEvent } from "./backend";
import { normalizeTaggedBackendEvent } from "./shared";

export const PI_CAPABILITIES: AgentBackendCapabilities = {
  sessions: true,
  streaming: true,
  messagePaging: false,
  images: true,
  models: true,
  agents: false,
  commands: true,
  compact: true,
  fork: true,
  revert: false,
  permissions: false,
  questions: false,
  providerAuth: true,
  mcp: false,
  skills: false,
  config: false,
  localServer: false,
};

export const PI_WORKSPACE = {
  kind: "local-cli",
  fields: {
    serverUrl: false,
    username: false,
    password: false,
    directory: true,
  },
} as const;

export function normalizePiEvent(event: NativeBackendEvent): AgentBackendEvent | null {
  return normalizeTaggedBackendEvent("pi", event, "pi:event");
}
