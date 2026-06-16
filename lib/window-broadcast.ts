import { createRequire } from "node:module";
import type { BrowserWindow as BrowserWindowType } from "electron";

const require = createRequire(import.meta.url);
const { BrowserWindow } = require("electron") as { BrowserWindow: typeof BrowserWindowType };

function broadcastToAllWindows(channel: string, payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

export { broadcastToAllWindows };
