import { AGENT_BACKEND_IDS } from "../../src/agents/index.ts";

export function getBackendCapabilities() {
  return {
    protocolVersion: 1,
    server: {
      workspaces: false,
      projects: false,
      sessions: false,
      events: "websocket" as const,
      auth: false,
      allowedRoots: true,
    },
    agentBackends: AGENT_BACKEND_IDS,
  };
}
