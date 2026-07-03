import { registerHarnessRpcHandlers } from "./harness-adapter-host.ts";
import {
  asHarnessString,
  parsePiProjectTarget,
  parsePiPromptArgs,
  parsePiSessionCreatePayload,
  parsePiSessionInput,
  parsePiStartSessionInput,
} from "./pi-bridge-rpc.ts";

export type PiDaemonClientLike = {
  addProject(config: { directory?: string; workspaceId?: string }): Promise<unknown>;
  removeProject(target: { directory?: string; workspaceId?: string }): Promise<unknown>;
  disconnect(): Promise<unknown>;
  listSessions(target: { directory?: string; workspaceId?: string }): Promise<unknown>;
  createSession(input: unknown): Promise<unknown>;
  deleteSession(
    sessionId: string,
    target: { directory?: string; workspaceId?: string },
  ): Promise<unknown>;
  updateSession(
    sessionId: string,
    title: string,
    target: { directory?: string; workspaceId?: string },
  ): Promise<unknown>;
  getSessionStatuses(target: { directory?: string; workspaceId?: string }): Promise<unknown>;
  forkSession(
    sessionId: string,
    messageID: string,
    target: { directory?: string; workspaceId?: string },
  ): Promise<unknown>;
  getProviders(target: { directory?: string; workspaceId?: string }): Promise<unknown>;
  listAllProviders(target: { directory?: string; workspaceId?: string }): Promise<unknown>;
  getProviderAuthMethods(target: { directory?: string; workspaceId?: string }): Promise<unknown>;
  connectProvider(
    target: { directory?: string; workspaceId?: string },
    providerID: string,
    auth: unknown,
  ): Promise<unknown>;
  disconnectProvider(
    target: { directory?: string; workspaceId?: string },
    providerID: string,
  ): Promise<unknown>;
  oauthAuthorize(
    target: { directory?: string; workspaceId?: string },
    providerID: string,
    method: string,
  ): Promise<unknown>;
  oauthCallback(
    target: { directory?: string; workspaceId?: string },
    providerID: string,
    method: string,
    code: string,
  ): Promise<unknown>;
  disposeProviderInstance(target: { directory?: string; workspaceId?: string }): Promise<unknown>;
  getAgents(): Promise<unknown>;
  getCommands(target: { directory?: string; workspaceId?: string }): Promise<unknown>;
  getMessages(
    sessionId: string,
    options: unknown,
    target: { directory?: string; workspaceId?: string },
  ): Promise<unknown>;
  startSession(input: unknown): Promise<unknown>;
  prompt(args: unknown): Promise<unknown>;
  abort(sessionId: string, directory: string, workspaceId: string | undefined): Promise<unknown>;
  sendCommand(
    sessionId: string,
    command: string,
    args: string,
    model: unknown,
    agent: unknown,
    variant: unknown,
    directory: string,
    workspaceId: string | undefined,
  ): Promise<unknown>;
  summarizeSession(
    sessionId: string,
    model: unknown,
    directory: string,
    workspaceId: string | undefined,
  ): Promise<unknown>;
};

export function registerPiHarnessRpcHandlers(
  ipcMain: Parameters<typeof registerHarnessRpcHandlers>[1],
  manager: PiDaemonClientLike,
) {
  registerHarnessRpcHandlers("pi", ipcMain, {
    "project:add": async (config) => {
      const cfg = parsePiSessionInput(config);
      await manager.addProject({
        directory: asHarnessString(cfg.directory),
        workspaceId: asHarnessString(cfg.workspaceId),
      });
      return true;
    },
    "project:remove": async (directory, workspaceId) => {
      await manager.removeProject(parsePiProjectTarget(directory, workspaceId));
      return true;
    },
    disconnect: async () => {
      await manager.disconnect();
      return true;
    },
    "session:list": (directory, workspaceId) =>
      manager.listSessions(parsePiProjectTarget(directory, workspaceId)),
    "session:create": (title, directory, workspaceId) =>
      manager.createSession(parsePiSessionCreatePayload(title, directory, workspaceId)),
    "session:delete": (sessionId, directory, workspaceId) =>
      manager.deleteSession(
        asHarnessString(sessionId) ?? "",
        parsePiProjectTarget(directory, workspaceId),
      ),
    "session:update": (sessionId, title, directory, workspaceId) =>
      manager.updateSession(
        asHarnessString(sessionId) ?? "",
        asHarnessString(title) ?? "",
        parsePiProjectTarget(directory, workspaceId),
      ),
    "session:statuses": (directory, workspaceId) =>
      manager.getSessionStatuses(parsePiProjectTarget(directory, workspaceId)),
    "session:fork": (sessionId, messageID, directory, workspaceId) =>
      manager.forkSession(
        asHarnessString(sessionId) ?? "",
        asHarnessString(messageID) ?? "",
        parsePiProjectTarget(directory, workspaceId),
      ),
    providers: (directory, workspaceId) =>
      manager.getProviders(parsePiProjectTarget(directory, workspaceId)),
    "provider:list": (directory, workspaceId) =>
      manager.listAllProviders(parsePiProjectTarget(directory, workspaceId)),
    "provider:auth-methods": (directory, workspaceId) =>
      manager.getProviderAuthMethods(parsePiProjectTarget(directory, workspaceId)),
    "provider:connect": (directory, workspaceId, providerID, auth) =>
      manager.connectProvider(
        parsePiProjectTarget(directory, workspaceId),
        asHarnessString(providerID) ?? "",
        auth,
      ),
    "provider:disconnect": (directory, workspaceId, providerID) =>
      manager.disconnectProvider(
        parsePiProjectTarget(directory, workspaceId),
        asHarnessString(providerID) ?? "",
      ),
    "provider:oauth:authorize": (directory, workspaceId, providerID, method) =>
      manager.oauthAuthorize(
        parsePiProjectTarget(directory, workspaceId),
        asHarnessString(providerID) ?? "",
        asHarnessString(method) ?? "",
      ),
    "provider:oauth:callback": (directory, workspaceId, providerID, method, code) =>
      manager.oauthCallback(
        parsePiProjectTarget(directory, workspaceId),
        asHarnessString(providerID) ?? "",
        asHarnessString(method) ?? "",
        asHarnessString(code) ?? "",
      ),
    "instance:dispose": (directory, workspaceId) =>
      manager.disposeProviderInstance(parsePiProjectTarget(directory, workspaceId)),
    agents: () => manager.getAgents(),
    commands: (directory, workspaceId) =>
      manager.getCommands(parsePiProjectTarget(directory, workspaceId)),
    messages: (sessionId, options, directory, workspaceId) =>
      manager.getMessages(
        asHarnessString(sessionId) ?? "",
        options,
        parsePiProjectTarget(directory, workspaceId),
      ),
    "session:start": (input) => manager.startSession(parsePiStartSessionInput(input)),
    prompt: async (sessionId, text, images, model, agent, variant, directory, workspaceId) => {
      await manager.prompt(
        parsePiPromptArgs(sessionId, text, images, model, agent, variant, directory, workspaceId),
      );
      return true;
    },
    abort: async (sessionId, directory, workspaceId) => {
      await manager.abort(
        asHarnessString(sessionId) ?? "",
        asHarnessString(directory) ?? "",
        asHarnessString(workspaceId),
      );
      return true;
    },
    "command:send": async (
      sessionId,
      command,
      args,
      model,
      agent,
      variant,
      directory,
      workspaceId,
    ) => {
      await manager.sendCommand(
        asHarnessString(sessionId) ?? "",
        asHarnessString(command) ?? "",
        asHarnessString(args) ?? "",
        model,
        agent,
        variant,
        asHarnessString(directory) ?? "",
        asHarnessString(workspaceId),
      );
      return true;
    },
    "session:summarize": async (sessionId, model, directory, workspaceId) => {
      await manager.summarizeSession(
        asHarnessString(sessionId) ?? "",
        model,
        asHarnessString(directory) ?? "",
        asHarnessString(workspaceId),
      );
      return true;
    },
  });
}
