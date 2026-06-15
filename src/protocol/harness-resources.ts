/** OpenGUI-owned presentation shapes for Harness resource catalogs. */

export interface ProviderResource {
  id: string;
  name?: string;
}

export interface SlashCommandResource {
  name: string;
  description?: string;
  source?: string;
}

export type McpConnectionStatus =
  | "connected"
  | "disabled"
  | "failed"
  | "needs_auth"
  | "needs_client_registration"
  | (string & {});

export interface McpServerStatus {
  status: McpConnectionStatus;
  error?: string;
}
