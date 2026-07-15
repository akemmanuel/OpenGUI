import {
  createElectronDesktopShell,
  createWebDesktopShell,
  type DesktopShellClient,
} from "@/shell/client";

let desktopShell: DesktopShellClient | null = null;

function isElectronRuntime() {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
}

export function getDesktopShellClient(): DesktopShellClient {
  if (desktopShell) return desktopShell;
  const electronApi = window.electronAPI;
  desktopShell =
    (electronApi?.kind === "electron" || isElectronRuntime()) && electronApi
      ? createElectronDesktopShell(electronApi)
      : createWebDesktopShell();
  return desktopShell;
}
