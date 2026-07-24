import { contextBridge, ipcRenderer } from "electron";
import pkg from "./package.json" with { type: "json" };
import { createElectronAPI, type PreloadIpc } from "./main/preload-api";

const electronAPI = createElectronAPI({
  ipc: ipcRenderer as unknown as PreloadIpc,
  locationSearch: window.location.search,
  currentVersion: pkg.version,
  reportSubscriptionError: (error) => {
    console.error("Failed to subscribe to backend events", error);
  },
});

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
