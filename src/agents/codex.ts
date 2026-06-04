import type { NativeBackendEvent } from "@/types/electron";
import type { HarnessCapabilities, HarnessEvent } from "./backend.ts";
import { normalizeTaggedBackendEvent } from "./shared.ts";

export const CODEX_CAPABILITIES: HarnessCapabilities = {
  sessions: true,
  streaming: true,
  messagePaging: false,
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

export function normalizeCodexEvent(event: NativeBackendEvent): HarnessEvent | null {
  return normalizeTaggedBackendEvent("codex", event, "codex:event");
}
