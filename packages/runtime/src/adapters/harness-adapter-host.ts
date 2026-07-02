import { fail, ok } from "./harness-adapter-kit.ts";

type RpcHandler = (...args: unknown[]) => unknown;

type HarnessTarget = {
  directory: unknown;
  workspaceId: unknown;
};

export type ObjectTargetHarnessManager = {
  addProject(config: unknown): unknown;
  removeProject(target: HarnessTarget): unknown;
  disconnect(): unknown;
  listSessions(target: HarnessTarget): unknown;
  createSession(input: { title: unknown; directory: unknown; workspaceId: unknown }): unknown;
  deleteSession(sessionId: unknown, target: HarnessTarget): unknown;
  updateSession(sessionId: unknown, title: unknown, target: HarnessTarget): unknown;
  getSessionStatuses(target: HarnessTarget): unknown;
  getProviders(): unknown;
  getAgents(): unknown;
  getCommands(): unknown;
  getMessages(sessionId: unknown, target: HarnessTarget): unknown;
  startSession(input: unknown): unknown;
  prompt(
    sessionId: unknown,
    text: unknown,
    images: unknown,
    model: unknown,
    agent: unknown,
    variant: unknown,
    directory: unknown,
    workspaceId: unknown,
  ): unknown;
  abort(sessionId: unknown): unknown;
  sendCommand(
    sessionId: unknown,
    command: unknown,
    args: unknown,
    model: unknown,
    agent: unknown,
    variant: unknown,
    directory: unknown,
    workspaceId: unknown,
  ): unknown;
  summarizeSession(
    sessionId: unknown,
    model: unknown,
    directory: unknown,
    workspaceId: unknown,
  ): unknown;
};

type IpcMainLike = {
  handle(channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>): void;
};

type WindowLike = {
  isDestroyed?: () => boolean;
  webContents: {
    send(channel: string, event: unknown): void;
  };
};

type SenderLike = {
  isDestroyed?: () => boolean;
  send(channel: string, event: unknown): void;
};

export function makeHarnessBridgeEventEmitter(
  harnessId: string,
  getAllWindows: () => Iterable<WindowLike>,
) {
  const channel = `${harnessId}:bridge-event`;
  return (event: unknown) => {
    for (const window of getAllWindows()) {
      if (!window || window.isDestroyed?.()) continue;
      try {
        window.webContents.send(channel, event);
      } catch {
        // Window may have closed between enumeration and send.
      }
    }
  };
}

export function makeHarnessBridgeEventSender(harnessId: string) {
  const channel = `${harnessId}:bridge-event`;
  return (sender: SenderLike, event: unknown) => {
    if (!sender || sender.isDestroyed?.()) return;
    try {
      sender.send(channel, event);
    } catch {
      // Sender may have closed between lookup and send.
    }
  };
}

export function registerHarnessRpcHandlers(
  harnessId: string,
  ipcMain: IpcMainLike,
  handlers: Record<string, RpcHandler>,
) {
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`${harnessId}:${name}`, async (_event, ...args) => {
      try {
        return ok(await handler(...args));
      } catch (error) {
        return fail(error);
      }
    });
  }
}

export function registerObjectTargetHarnessRpcHandlers(
  harnessId: string,
  ipcMain: IpcMainLike,
  getManager: () => ObjectTargetHarnessManager,
) {
  const target = (directory: unknown, workspaceId: unknown) => ({ directory, workspaceId });

  registerHarnessRpcHandlers(harnessId, ipcMain, {
    "project:add": async (config) => {
      await getManager().addProject(config);
      return true;
    },
    "project:remove": async (directory, workspaceId) => {
      await getManager().removeProject(target(directory, workspaceId));
      return true;
    },
    disconnect: () => {
      getManager().disconnect();
      return true;
    },
    "session:list": (directory, workspaceId) =>
      getManager().listSessions(target(directory, workspaceId)),
    "session:create": (title, directory, workspaceId) =>
      getManager().createSession({ title, directory, workspaceId }),
    "session:delete": (sessionId, directory, workspaceId) =>
      getManager().deleteSession(sessionId, target(directory, workspaceId)),
    "session:update": (sessionId, title, directory, workspaceId) =>
      getManager().updateSession(sessionId, title, target(directory, workspaceId)),
    "session:statuses": (directory, workspaceId) =>
      getManager().getSessionStatuses(target(directory, workspaceId)),
    providers: () => getManager().getProviders(),
    agents: () => getManager().getAgents(),
    commands: () => getManager().getCommands(),
    messages: (sessionId, _options, directory, workspaceId) =>
      getManager().getMessages(sessionId, target(directory, workspaceId)),
    "session:start": (input) => getManager().startSession(input ?? {}),
    prompt: async (sessionId, text, images, model, agent, variant, directory, workspaceId) => {
      await getManager().prompt(
        sessionId,
        text,
        images,
        model,
        agent,
        variant,
        directory,
        workspaceId,
      );
      return true;
    },
    abort: (sessionId) => getManager().abort(sessionId),
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
      await getManager().sendCommand(
        sessionId,
        command,
        args,
        model,
        agent,
        variant,
        directory,
        workspaceId,
      );
      return true;
    },
    "session:summarize": async (sessionId, model, directory, workspaceId) => {
      await getManager().summarizeSession(sessionId, model, directory, workspaceId);
      return true;
    },
  });
}
