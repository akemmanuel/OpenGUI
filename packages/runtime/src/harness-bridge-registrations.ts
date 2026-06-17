import type { HarnessId } from "../../../src/agents/harness-ids.ts";
import { HARNESS_ID_VALUES } from "../../../src/agents/harness-ids.ts";
import { setupClaudeCodeBridge } from "./adapters/claude-code-bridge.ts";
import { setupCodexBridge } from "./adapters/codex-bridge.ts";
import { setupOpenCodeBridge } from "./adapters/opencode-bridge.ts";
import { setupPiBridge } from "./adapters/pi-bridge.ts";

export type HarnessWindow = {
  isDestroyed(): boolean;
  webContents: { send(channel: string, data: unknown): void };
};

type IpcSender = { send(channel: string, data: unknown): void };

type IpcEvent = { sender: IpcSender };

type Handler = (event: IpcEvent, ...args: unknown[]) => unknown;

export type HarnessIpcMainForBridge = {
  handle(channel: string, handler: Handler): void;
  on(channel: string, handler: Handler): void;
  send(channel: string, event: IpcEvent, args?: unknown[]): void;
};

export type HarnessControl = {
  restart?: () => Promise<unknown>;
};

export type RegisterBridgeContext = {
  ipcMain: HarnessIpcMainForBridge;
  getAllWindows: () => HarnessWindow[];
  dataDir: string;
  sender: IpcSender;
};

export type RegisterBridgeFn = (ctx: RegisterBridgeContext) => HarnessControl;

/** Single table: registry row + meta + adapter file, then one entry here. */
export const BRIDGE_SETUP_BY_HARNESS_ID: Record<HarnessId, RegisterBridgeFn> = {
  opencode: ({ ipcMain, getAllWindows }) =>
    setupOpenCodeBridge(
      ipcMain as Parameters<typeof setupOpenCodeBridge>[0],
      getAllWindows as Parameters<typeof setupOpenCodeBridge>[1],
    ),
  "claude-code": ({ ipcMain, getAllWindows, sender }) => {
    const control = setupClaudeCodeBridge(
      ipcMain as Parameters<typeof setupClaudeCodeBridge>[0],
      getAllWindows as Parameters<typeof setupClaudeCodeBridge>[1],
    );
    ipcMain.send("claude-code:renderer-ready", { sender });
    return control;
  },
  pi: ({ ipcMain, getAllWindows, dataDir }) =>
    setupPiBridge(
      ipcMain as Parameters<typeof setupPiBridge>[0],
      getAllWindows as Parameters<typeof setupPiBridge>[1],
      { userData: dataDir },
    ),
  codex: ({ ipcMain, getAllWindows, dataDir }) =>
    setupCodexBridge(
      ipcMain as Parameters<typeof setupCodexBridge>[0],
      getAllWindows as Parameters<typeof setupCodexBridge>[1],
      { userData: dataDir },
    ),
};

function assertBridgeTableMatchesIds() {
  const keys = Object.keys(BRIDGE_SETUP_BY_HARNESS_ID).sort().join(",");
  const ids = [...HARNESS_ID_VALUES].sort().join(",");
  if (keys !== ids) {
    throw new Error(`BRIDGE_SETUP_BY_HARNESS_ID keys must match HARNESS_ID_VALUES (${ids})`);
  }
}
assertBridgeTableMatchesIds();
