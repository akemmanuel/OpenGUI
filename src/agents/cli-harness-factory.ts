import type { NativeBackendEvent } from "@/types/electron";
import type { HarnessCapabilities, HarnessEvent } from "./backend.ts";
import type { HarnessId } from "./index.ts";
import { normalizeTaggedBackendEvent } from "./shared.ts";

export const LOCAL_CLI_WORKSPACE = {
  kind: "local-cli",
  fields: {
    serverUrl: false,
    username: false,
    password: false,
    directory: true,
  },
} as const;

const DEFAULT_LOCAL_CLI_CAPABILITIES: HarnessCapabilities = {
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

export function makeLocalCliCapabilities(
  overrides: Partial<HarnessCapabilities> = {},
): HarnessCapabilities {
  return { ...DEFAULT_LOCAL_CLI_CAPABILITIES, ...overrides };
}

export function createCliHarnessNormalizer(harnessId: HarnessId, nativeEventType?: string) {
  const eventType = nativeEventType ?? `${harnessId}:event`;
  return (event: NativeBackendEvent): HarnessEvent | null =>
    normalizeTaggedBackendEvent(harnessId, event, eventType);
}
