export type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "error";
export type ConnectionKind = "project";

/** Canonical connection state shared by host and renderer code. */
export interface ConnectionStatus {
  state: ConnectionState;
  kind?: ConnectionKind;
  serverUrl: string | null;
  serverVersion: string | null;
  error: string | null;
  lastEventAt: number | null;
}

export interface ConnectionConfig {
  workspaceId?: string;
  baseUrl: string;
  username?: string;
  password?: string;
  authToken?: string;
  directory?: string;
}
