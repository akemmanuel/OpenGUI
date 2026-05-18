// @ts-nocheck
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { BrowserWindow } = require("electron");

function broadcastToAllWindows(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

export { broadcastToAllWindows };
