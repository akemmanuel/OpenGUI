import type { ElectronAPI } from "./preload-api";

declare global {
  interface Window {
    Capacitor?: { isNativePlatform?: () => boolean };
    electronAPI?: ElectronAPI;
  }
}
