export type DesktopPlatform = NodeJS.Platform | (string & {});

export function isWebUrl(rawUrl: unknown): rawUrl is string {
  if (typeof rawUrl !== "string") return false;
  try {
    const protocol = new URL(rawUrl).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function isAllowedAppNavigation(rawUrl: string, appEntryUrl: string) {
  try {
    const requested = new URL(rawUrl);
    const appEntry = new URL(appEntryUrl);
    if (requested.protocol !== appEntry.protocol) return false;
    if (requested.protocol === "file:") return requested.pathname === appEntry.pathname;
    return requested.origin === appEntry.origin;
  } catch {
    return false;
  }
}

export function installWebNavigationPolicy(input: {
  webContents: {
    setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): unknown;
    on(
      event: "will-navigate",
      handler: (event: { preventDefault(): void }, url: string) => void,
    ): unknown;
  };
  appEntryUrl: string;
  openExternal(url: string): unknown;
}) {
  input.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void input.openExternal(url);
    return { action: "deny" };
  });
  input.webContents.on("will-navigate", (event, url) => {
    if (isAllowedAppNavigation(url, input.appEntryUrl)) return;
    event.preventDefault();
    if (isWebUrl(url)) void input.openExternal(url);
  });
}

export function defaultTerminalInvocation(platform: DesktopPlatform, directory: string) {
  if (platform === "darwin") {
    return { command: "open", args: ["-a", "Terminal", directory], shell: false };
  }
  if (platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/c", "start", "cmd.exe", "/k", `cd /d "${directory}"`],
      shell: true,
    };
  }
  return null;
}

export function installDesktopChromiumSwitches(
  platform: DesktopPlatform,
  commandLine: { appendSwitch(name: string, value?: string): void },
) {
  if (platform !== "darwin") return;
  // Keep Chromium compositor tiles and the native NSView backing store in one
  // color path. GPU memory-buffer compositor resources can color-convert only
  // some 256px tiles on macOS, producing horizontal dark bands.
  commandLine.appendSwitch("disable-gpu-memory-buffer-compositor-resources");
  commandLine.appendSwitch("force-color-profile", "srgb");
}

export function desktopWindowFrameOptions(platform: DesktopPlatform) {
  if (platform === "darwin") {
    return {
      // Opaque frameless window: frame stays false; customButtonsOnHover only
      // suppresses the native title-bar line, not the custom window chrome.
      backgroundColor: "#131313",
      titleBarStyle: "customButtonsOnHover" as const,
      trafficLightPosition: { x: -100, y: -100 },
    };
  }
  return { backgroundColor: "#1a1a1a" };
}

export function shouldQuitWhenAllWindowsClosed(platform: DesktopPlatform) {
  return platform !== "darwin";
}

export function handleDesktopActivate(input: { windowCount: number; createWindow: () => void }) {
  if (input.windowCount === 0) input.createWindow();
}

export function createBeforeQuitHandler(input: {
  stopBackend: () => Promise<void>;
  quit: () => void;
  reportError?: (error: unknown) => void;
}) {
  let shutdownStarted = false;
  let shutdownFinished = false;
  return (event: { preventDefault(): void }) => {
    if (shutdownFinished) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    void input
      .stopBackend()
      .catch(input.reportError)
      .finally(() => {
        shutdownFinished = true;
        input.quit();
      });
  };
}
