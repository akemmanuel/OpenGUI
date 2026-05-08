const { BrowserWindow } = require("electron/main");

function broadcastToAllWindows(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

module.exports = { broadcastToAllWindows };
