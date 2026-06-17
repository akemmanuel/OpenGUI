import { HARNESS_IDS } from "../../src/agents/index.ts";
import type { OpenGuiCapabilities } from "../../src/protocol/client.ts";

export function getBackendCapabilities(): OpenGuiCapabilities {
  return {
    protocolVersion: 1,
    server: {
      workspaces: false,
      projects: false,
      sessions: true,
      events: "sse",
      auth: false,
      allowedRoots: true,
    },
    harnesses: HARNESS_IDS,
  };
}
