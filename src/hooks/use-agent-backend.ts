import { useMemo } from "react";

export interface AgentCapabilities {
  sessions: boolean;
  streaming: boolean;
  messagePaging: boolean;
  models: boolean;
  agents: boolean;
  commands: boolean;
  compact: boolean;
  fork: boolean;
  revert: boolean;
  permissions: boolean;
  questions: boolean;
  providerAuth: boolean;
  config: boolean;
  localServer: boolean;
}

const FIRST_PARTY_CAPABILITIES: AgentCapabilities = {
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
  config: false,
  localServer: true,
};

export function useBackendCapabilities(): AgentCapabilities {
  return useMemo(() => FIRST_PARTY_CAPABILITIES, []);
}
