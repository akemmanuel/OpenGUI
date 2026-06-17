import type { HarnessEvent } from "../../../src/agents/backend.ts";
import type { HarnessId } from "../../../src/agents/harness-ids.ts";
import { HARNESS_ID_VALUES } from "../../../src/agents/harness-ids.ts";
import { HARNESS_BACKEND_META } from "../../../src/agents/cli-harness-factory.ts";
import {
  BRIDGE_SETUP_BY_HARNESS_ID,
  type HarnessControl,
  type HarnessIpcMainForBridge,
  type HarnessWindow,
} from "./harness-bridge-registrations.ts";

interface IpcSender {
  send(channel: string, data: unknown): void;
}

interface IpcEvent {
  sender: IpcSender;
}

type Handler = (event: IpcEvent, ...args: unknown[]) => unknown;

export interface HarnessIpcMain extends HarnessIpcMainForBridge {
  handle(channel: string, handler: Handler): void;
  on(channel: string, handler: Handler): void;
  send(channel: string, event: IpcEvent, args?: unknown[]): void;
}

export type { HarnessControl };

export const MANAGED_HARNESS_IDS = [...HARNESS_ID_VALUES] as const satisfies readonly HarnessId[];

export type ManagedHarnessId = (typeof MANAGED_HARNESS_IDS)[number];

const BRIDGE_EVENT_NORMALIZERS: Record<ManagedHarnessId, (event: unknown) => HarnessEvent | null> =
  Object.fromEntries(
    MANAGED_HARNESS_IDS.map((harnessId) => [
      harnessId,
      HARNESS_BACKEND_META[harnessId].normalizeEvent,
    ]),
  ) as Record<ManagedHarnessId, (event: unknown) => HarnessEvent | null>;

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

export interface RegisterHarnessAdaptersInput {
  ipcMain: HarnessIpcMain;
  sender: IpcSender;
  dataDir: string;
  broadcast: (channel: string, data: unknown) => void;
  /** When set, only these adapters register (lazy cold start). */
  harnessIds?: readonly HarnessId[];
}

function resolveManagedHarnessSubset(
  harnessIds: readonly HarnessId[] | undefined,
): ManagedHarnessId[] {
  if (!harnessIds?.length) return [...MANAGED_HARNESS_IDS];
  const wanted = new Set(harnessIds);
  return MANAGED_HARNESS_IDS.filter((id) => wanted.has(id));
}

export function registerHarnessAdapters(
  input: RegisterHarnessAdaptersInput,
): ReadonlyMap<ManagedHarnessId, HarnessControl> {
  const { ipcMain, sender, dataDir, broadcast } = input;
  const activeIds = resolveManagedHarnessSubset(input.harnessIds);
  const getAllWindows = (): HarnessWindow[] => [
    {
      isDestroyed: () => false,
      webContents: { send: (channel: string, data: unknown) => broadcast(channel, data) },
    },
  ];

  const ctx = { ipcMain, getAllWindows, dataDir, sender };
  const controls = new Map<ManagedHarnessId, HarnessControl>();
  for (const harnessId of activeIds) {
    controls.set(harnessId, BRIDGE_SETUP_BY_HARNESS_ID[harnessId](ctx));
  }
  return controls;
}
