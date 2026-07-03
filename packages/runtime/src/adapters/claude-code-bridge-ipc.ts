import { registerHarnessRpcHandlers } from "./harness-adapter-host.ts";
import { coerceHarnessModelRef, coerceVariant } from "./pi-bridge-rpc.ts";
import { parsePermissionResponse } from "./opencode-ipc-parse.ts";
import {
  asOptionalHarnessIpcString,
  asRequiredHarnessIpcString,
} from "./harness-bridge-ipc-coerce.ts";
import type { ClaudeGetMessagesOptions, HarnessModelRef } from "./claude-code-bridge-types.ts";
import { parseStartSessionInput } from "./claude-code-bridge-mapping.ts";

export type ClaudeCodeBridgeManagerLike = {
  attachProject(config: { directory: string; workspaceId?: string }): void;
  removeProject(directory: string, workspaceId: string | undefined): void;
  disconnect(): void;
  listSessions(directory: string | undefined, workspaceId: string | undefined): unknown;
  createSession(input: { title?: string; directory?: string; workspaceId?: string }): unknown;
  deleteSession(
    sessionId: string,
    directory: string | undefined,
    workspaceId: string | undefined,
  ): unknown;
  renameSession(
    sessionId: string,
    title: string,
    directory: string | undefined,
    workspaceId: string | undefined,
  ): unknown;
  listSessionStatuses(directory: string | undefined, workspaceId: string | undefined): unknown;
  forkSession(
    sessionId: string,
    messageID: string,
    directory: string | undefined,
    workspaceId: string | undefined,
  ): unknown;
  getProviders(directory: string | undefined, workspaceId: string | undefined): unknown;
  getAgents(): unknown;
  getCommands(directory: string | undefined, workspaceId: string | undefined): unknown;
  getMessages(
    sessionId: string,
    options: ClaudeGetMessagesOptions | undefined,
    directory: string | undefined,
    workspaceId: string | undefined,
  ): unknown;
  startSession(input: unknown): unknown;
  prompt(params: {
    sessionId: string;
    text: string;
    images: unknown;
    model: HarnessModelRef | undefined;
    agent: unknown;
    variant: string | undefined;
    directory: string | undefined;
    workspaceId: string | undefined;
  }): Promise<unknown>;
  abort(sessionId: string): unknown;
  respondPermission(sessionId: string, permissionId: string, response: unknown): unknown;
  sendCommand(
    sessionId: string,
    command: string,
    args: string,
    model: unknown,
    agent: unknown,
    variant: unknown,
    directory: string | undefined,
    workspaceId: string | undefined,
  ): unknown;
  summarizeSession(
    sessionId: string,
    model: unknown,
    directory: string | undefined,
    workspaceId: string | undefined,
  ): unknown;
};

export function registerClaudeCodeHarnessRpcHandlers(
  ipcMain: Parameters<typeof registerHarnessRpcHandlers>[1],
  manager: ClaudeCodeBridgeManagerLike,
) {
  registerHarnessRpcHandlers("claude-code", ipcMain, {
    "project:add": (...args: unknown[]) => {
      const config = args[0];
      const row = config && typeof config === "object" && !Array.isArray(config) ? config : {};
      const directory = asRequiredHarnessIpcString(
        (row as { directory?: unknown }).directory,
        "directory",
      );
      manager.attachProject({
        directory,
        workspaceId: asOptionalHarnessIpcString((row as { workspaceId?: unknown }).workspaceId),
      });
      return true;
    },
    "project:remove": (...args: unknown[]) => {
      const [directory, workspaceId] = args;
      manager.removeProject(
        asRequiredHarnessIpcString(directory, "directory"),
        asOptionalHarnessIpcString(workspaceId),
      );
      return true;
    },
    disconnect: (..._args: unknown[]) => {
      manager.disconnect();
      return true;
    },
    "session:list": (...args: unknown[]) => {
      const [directory, workspaceId] = args;
      return manager.listSessions(
        asOptionalHarnessIpcString(directory),
        asOptionalHarnessIpcString(workspaceId),
      );
    },
    "session:create": (...args: unknown[]) => {
      const [title, directory, workspaceId] = args;
      return manager.createSession({
        title: asOptionalHarnessIpcString(title),
        directory: asOptionalHarnessIpcString(directory),
        workspaceId: asOptionalHarnessIpcString(workspaceId),
      });
    },
    "session:delete": (...args: unknown[]) => {
      const [sessionId, directory, workspaceId] = args;
      return manager.deleteSession(
        asRequiredHarnessIpcString(sessionId, "sessionId"),
        asOptionalHarnessIpcString(directory),
        asOptionalHarnessIpcString(workspaceId),
      );
    },
    "session:update": (...args: unknown[]) => {
      const [sessionId, title, directory, workspaceId] = args;
      return manager.renameSession(
        asRequiredHarnessIpcString(sessionId, "sessionId"),
        asRequiredHarnessIpcString(title, "title"),
        asOptionalHarnessIpcString(directory),
        asOptionalHarnessIpcString(workspaceId),
      );
    },
    "session:statuses": (...args: unknown[]) => {
      const [directory, workspaceId] = args;
      return manager.listSessionStatuses(
        asOptionalHarnessIpcString(directory),
        asOptionalHarnessIpcString(workspaceId),
      );
    },
    "session:fork": (...args: unknown[]) => {
      const [sessionId, messageID, directory, workspaceId] = args;
      return manager.forkSession(
        asRequiredHarnessIpcString(sessionId, "sessionId"),
        asRequiredHarnessIpcString(messageID, "messageID"),
        asOptionalHarnessIpcString(directory),
        asOptionalHarnessIpcString(workspaceId),
      );
    },
    providers: (...args: unknown[]) => {
      const [directory, workspaceId] = args;
      return manager.getProviders(
        asOptionalHarnessIpcString(directory),
        asOptionalHarnessIpcString(workspaceId),
      );
    },
    agents: (..._args: unknown[]) => manager.getAgents(),
    commands: (...args: unknown[]) => {
      const [directory, workspaceId] = args;
      return manager.getCommands(
        asOptionalHarnessIpcString(directory),
        asOptionalHarnessIpcString(workspaceId),
      );
    },
    messages: (...args: unknown[]) => {
      const [sessionId, options, directory, workspaceId] = args;
      return manager.getMessages(
        asRequiredHarnessIpcString(sessionId, "sessionId"),
        options && typeof options === "object" && !Array.isArray(options)
          ? (options as ClaudeGetMessagesOptions)
          : undefined,
        asOptionalHarnessIpcString(directory),
        asOptionalHarnessIpcString(workspaceId),
      );
    },
    "session:start": (...args: unknown[]) => manager.startSession(parseStartSessionInput(args[0])),
    prompt: async (...args: unknown[]) => {
      const [sessionId, text, images, model, agent, variant, directory, workspaceId] = args;
      const modelRef = coerceHarnessModelRef(model);
      const harnessModel: HarnessModelRef | undefined = modelRef?.modelID
        ? { modelID: modelRef.modelID }
        : undefined;
      await manager.prompt({
        sessionId: asRequiredHarnessIpcString(sessionId, "sessionId"),
        text: asRequiredHarnessIpcString(text, "text"),
        images,
        model: harnessModel,
        agent,
        variant: coerceVariant(variant),
        directory: asOptionalHarnessIpcString(directory),
        workspaceId: asOptionalHarnessIpcString(workspaceId),
      });
      return true;
    },
    abort: (...args: unknown[]) => manager.abort(asRequiredHarnessIpcString(args[0], "sessionId")),
    permission: (...args: unknown[]) => {
      const [sessionId, permissionId, response] = args;
      const parsed = parsePermissionResponse(response);
      if (!parsed) {
        throw new TypeError("permission response must be always, once, or reject");
      }
      return manager.respondPermission(
        asRequiredHarnessIpcString(sessionId, "sessionId"),
        asRequiredHarnessIpcString(permissionId, "permissionId"),
        parsed,
      );
    },
    "command:send": (...args: unknown[]) => {
      const [sessionId, command, commandArgs, model, agent, variant, directory, workspaceId] = args;
      return manager.sendCommand(
        asRequiredHarnessIpcString(sessionId, "sessionId"),
        asRequiredHarnessIpcString(command, "command"),
        asRequiredHarnessIpcString(commandArgs, "args"),
        model,
        agent,
        variant,
        asOptionalHarnessIpcString(directory),
        asOptionalHarnessIpcString(workspaceId),
      );
    },
    "session:summarize": (...args: unknown[]) => {
      const [sessionId, model, directory, workspaceId] = args;
      return manager.summarizeSession(
        asRequiredHarnessIpcString(sessionId, "sessionId"),
        model,
        asOptionalHarnessIpcString(directory),
        asOptionalHarnessIpcString(workspaceId),
      );
    },
  });
}
