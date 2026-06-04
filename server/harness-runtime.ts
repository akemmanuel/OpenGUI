import type { HarnessEvent } from "../src/agents/backend.ts";
import type { HarnessId } from "../src/agents/index.ts";
import { normalizeClaudeCodeEvent } from "../src/agents/claude-code.ts";
import { normalizeCodexEvent } from "../src/agents/codex.ts";
import { normalizeOpenCodeEvent } from "../src/agents/opencode.ts";
import { normalizePiEvent } from "../src/agents/pi.ts";
import { setupClaudeCodeBridge } from "../claude-code-bridge.ts";
import { setupCodexBridge } from "../codex-bridge.ts";
import { setupOpenCodeBridge } from "../opencode-bridge.ts";
import { setupPiBridge } from "../pi-bridge.ts";

interface IpcSender {
  send(channel: string, data: unknown): void;
}

interface IpcEvent {
  sender: IpcSender;
}

type Handler = (event: IpcEvent, ...args: unknown[]) => unknown;

interface HarnessIpcMain {
  handle(channel: string, handler: Handler): void;
  on(channel: string, handler: Handler): void;
  send(channel: string, event: IpcEvent, args?: unknown[]): void;
}

interface HarnessWindow {
  isDestroyed(): boolean;
  webContents: { send(channel: string, data: unknown): void };
}

export const MANAGED_HARNESS_IDS = [
  "opencode",
  "claude-code",
  "pi",
  "codex",
] as const satisfies readonly HarnessId[];

export type ManagedHarnessId = (typeof MANAGED_HARNESS_IDS)[number];

export interface HarnessControl {
  restart?: () => Promise<unknown>;
}

const BRIDGE_EVENT_NORMALIZERS: Record<ManagedHarnessId, (event: unknown) => HarnessEvent | null> =
  {
    opencode: (event) =>
      normalizeOpenCodeEvent(event as Parameters<typeof normalizeOpenCodeEvent>[0]),
    "claude-code": (event) =>
      normalizeClaudeCodeEvent(event as Parameters<typeof normalizeClaudeCodeEvent>[0]),
    pi: (event) => normalizePiEvent(event as Parameters<typeof normalizePiEvent>[0]),
    codex: (event) => normalizeCodexEvent(event as Parameters<typeof normalizeCodexEvent>[0]),
  };

export function isManagedHarnessId(value: unknown): value is ManagedHarnessId {
  return typeof value === "string" && MANAGED_HARNESS_IDS.includes(value as ManagedHarnessId);
}

export function getHarnessIdFromBridgeChannel(channel: string): ManagedHarnessId | null {
  return MANAGED_HARNESS_IDS.find((harnessId) => channel === `${harnessId}:bridge-event`) ?? null;
}

export function normalizeBridgeEvent(input: {
  harnessId: ManagedHarnessId;
  event: unknown;
}): HarnessEvent | null {
  return BRIDGE_EVENT_NORMALIZERS[input.harnessId]?.(input.event) ?? null;
}

export function registerHarnessAdapters(input: {
  ipcMain: HarnessIpcMain;
  sender: IpcSender;
  dataDir: string;
  broadcast: (channel: string, data: unknown) => void;
}): ReadonlyMap<ManagedHarnessId, HarnessControl> {
  const { ipcMain, sender, dataDir, broadcast } = input;
  const getAllWindows = (): HarnessWindow[] => [
    {
      isDestroyed: () => false,
      webContents: { send: (channel: string, data: unknown) => broadcast(channel, data) },
    },
  ];

  const controls = new Map<ManagedHarnessId, HarnessControl>();
  controls.set(
    "opencode",
    setupOpenCodeBridge(ipcMain as Parameters<typeof setupOpenCodeBridge>[0], getAllWindows),
  );
  controls.set(
    "claude-code",
    setupClaudeCodeBridge(ipcMain as Parameters<typeof setupClaudeCodeBridge>[0], getAllWindows),
  );
  ipcMain.send("claude-code:renderer-ready", { sender });
  controls.set(
    "pi",
    setupPiBridge(ipcMain as Parameters<typeof setupPiBridge>[0], getAllWindows, {
      userData: dataDir,
    }),
  );
  controls.set(
    "codex",
    setupCodexBridge(ipcMain as Parameters<typeof setupCodexBridge>[0], getAllWindows, {
      userData: dataDir,
    }),
  );
  return controls;
}
