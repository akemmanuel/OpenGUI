import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { BrowserWindow } = require("electron") as typeof import("electron");

interface BroadcastWindow {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: unknown): void };
}

function broadcastToAllWindows(
  channel: string,
  payload: unknown,
  getAllWindows: () => BroadcastWindow[] = () => BrowserWindow.getAllWindows(),
) {
  for (const win of getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

export { broadcastToAllWindows };
