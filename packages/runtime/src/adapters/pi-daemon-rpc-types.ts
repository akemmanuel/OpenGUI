/**
 * Pi daemon HTTP RPC method names (must match pi-daemon-server ALLOWED_METHODS).
 */
export type PiDaemonRpcMethod =
  | "addProject"
  | "removeProject"
  | "disconnect"
  | "listSessions"
  | "createSession"
  | "deleteSession"
  | "updateSession"
  | "getSessionStatuses"
  | "forkSession"
  | "getProviders"
  | "listAllProviders"
  | "getProviderAuthMethods"
  | "connectProvider"
  | "disconnectProvider"
  | "oauthAuthorize"
  | "oauthCallback"
  | "disposeProviderInstance"
  | "getAgents"
  | "getCommands"
  | "getMessages"
  | "startSession"
  | "prompt"
  | "abort"
  | "sendCommand"
  | "summarizeSession";

export const PI_DAEMON_RPC_METHODS: readonly PiDaemonRpcMethod[] = [
  "addProject",
  "removeProject",
  "disconnect",
  "listSessions",
  "createSession",
  "deleteSession",
  "updateSession",
  "getSessionStatuses",
  "forkSession",
  "getProviders",
  "listAllProviders",
  "getProviderAuthMethods",
  "connectProvider",
  "disconnectProvider",
  "oauthAuthorize",
  "oauthCallback",
  "disposeProviderInstance",
  "getAgents",
  "getCommands",
  "getMessages",
  "startSession",
  "prompt",
  "abort",
  "sendCommand",
  "summarizeSession",
] as const;

export function isPiDaemonRpcMethod(value: unknown): value is PiDaemonRpcMethod {
  return typeof value === "string" && (PI_DAEMON_RPC_METHODS as readonly string[]).includes(value);
}
