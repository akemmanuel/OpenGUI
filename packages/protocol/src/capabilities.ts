import type { HarnessId } from "./harness-id.ts";

/** Backend capability snapshot for `GET /api/capabilities`. */
export interface OpenGuiCapabilities {
  protocolVersion: number;
  server: {
    workspaces: boolean;
    projects: boolean;
    sessions: boolean;
    events: "websocket" | "sse" | false;
    auth: boolean;
    allowedRoots: boolean;
  };
  harnesses: HarnessId[];
}
