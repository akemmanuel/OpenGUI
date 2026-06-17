import type { NativeBackendEvent } from "@/types/electron";
import type { HarnessCapabilities, HarnessEvent } from "./backend.ts";
import type { ActiveHarnessId, HarnessId } from "./index.ts";
import { mapOpenCodeEvent } from "./protocol/opencode-map.ts";
import { normalizeTaggedHarnessEvent } from "./shared.ts";

export const LOCAL_CLI_CONNECTION = {
  kind: "local-cli",
  fields: {
    serverUrl: false,
    username: false,
    password: false,
    directory: true,
  },
} as const;

const NO_CAPABILITIES: HarnessCapabilities = {
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
  config: false,
  localServer: false,
};

function capabilities(...enabled: (keyof HarnessCapabilities)[]): HarnessCapabilities {
  return enabled.reduce((result, key) => ({ ...result, [key]: true }), { ...NO_CAPABILITIES });
}

export function makeLocalCliCapabilities(
  overrides: Partial<HarnessCapabilities> = {},
): HarnessCapabilities {
  return { ...NO_CAPABILITIES, ...overrides };
}

export function createCliHarnessNormalizer(harnessId: HarnessId, nativeEventType?: string) {
  const eventType = nativeEventType ?? `${harnessId}:event`;
  return (event: NativeBackendEvent): HarnessEvent | null =>
    normalizeTaggedHarnessEvent(harnessId, event, eventType);
}

function normalizeOpenCodeEvent(event: NativeBackendEvent): HarnessEvent | null {
  if (event.type === "connection:status") {
    return normalizeTaggedHarnessEvent("opencode", event, "opencode:event");
  }
  if (event.type !== "opencode:event" || !event.payload) return null;
  return mapOpenCodeEvent(event.payload, {
    directory: event.directory,
    workspaceId: event.workspaceId,
  });
}

export const HARNESS_BACKEND_META: Record<
  ActiveHarnessId,
  {
    capabilities: HarnessCapabilities;
    connection: typeof LOCAL_CLI_CONNECTION;
    normalizeEvent: (event: NativeBackendEvent) => HarnessEvent | null;
  }
> = {
  opencode: {
    capabilities: makeLocalCliCapabilities({
      messagePaging: true,
      models: true,
      agents: true,
      commands: true,
      revert: true,
      fork: true,
      permissions: true,
      questions: true,
      providerAuth: true,
      mcp: true,
      config: true,
      localServer: true,
    }),
    connection: LOCAL_CLI_CONNECTION,
    normalizeEvent: normalizeOpenCodeEvent,
  },
  "claude-code": {
    capabilities: capabilities("messagePaging", "commands", "compact", "fork", "permissions"),
    connection: LOCAL_CLI_CONNECTION,
    normalizeEvent: createCliHarnessNormalizer("claude-code"),
  },
  pi: {
    capabilities: capabilities("commands", "compact", "fork", "providerAuth"),
    connection: LOCAL_CLI_CONNECTION,
    normalizeEvent: createCliHarnessNormalizer("pi"),
  },
  codex: {
    capabilities: makeLocalCliCapabilities(),
    connection: LOCAL_CLI_CONNECTION,
    normalizeEvent: createCliHarnessNormalizer("codex"),
  },
};
