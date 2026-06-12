import type { NativeBackendEvent } from "@/types/electron";
import type { HarnessCapabilities, HarnessEvent } from "./backend.ts";
import { mapOpenCodeEvent } from "./protocol/opencode-map.ts";

export const OPENCODE_CAPABILITIES: HarnessCapabilities = {
  sessions: true,
  streaming: true,
  messagePaging: true,
  models: true,
  agents: true,
  commands: true,
  compact: true,
  fork: true,
  revert: true,
  permissions: true,
  questions: true,
  providerAuth: true,
  mcp: true,
  skills: true,
  config: true,
  localServer: true,
};

export const OPENCODE_WORKSPACE = {
  kind: "remote-server",
  fields: {
    serverUrl: true,
    username: true,
    password: true,
    directory: true,
  },
} as const;

export function normalizeOpenCodeEvent(event: NativeBackendEvent): HarnessEvent | null {
  if (event.type === "connection:status") {
    return {
      type: "connection.status",
      directory: event.directory,
      workspaceId: event.workspaceId,
      status: event.payload,
    };
  }

  if (event.type !== "opencode:event") return null;
  return mapOpenCodeEvent(event.payload, {
    directory: event.directory,
    workspaceId: event.workspaceId,
  });
}
