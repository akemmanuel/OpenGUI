import { describe, expect, test, vi } from "vite-plus/test";
import {
  defaultTerminalInvocation,
  createBeforeQuitHandler,
  handleDesktopActivate,
  installWebNavigationPolicy,
  isAllowedAppNavigation,
  isWebUrl,
  shouldQuitWhenAllWindowsClosed,
} from "./desktop-shell";

describe("Desktop platform decisions", () => {
  test.each([
    ["darwin", false],
    ["linux", true],
    ["win32", true],
  ])("window-all-closed quit behavior on %s", (platform, expected) => {
    expect(shouldQuitWhenAllWindowsClosed(platform)).toBe(expected);
  });

  test.each([
    ["darwin", "/project", { command: "open", args: ["-a", "Terminal", "/project"], shell: false }],
    [
      "win32",
      "C:\\Work Tree",
      {
        command: "cmd.exe",
        args: ["/c", "start", "cmd.exe", "/k", 'cd /d "C:\\Work Tree"'],
        shell: true,
      },
    ],
    ["linux", "/project", null],
  ])("chooses the native terminal boundary on %s", (platform, directory, expected) => {
    expect(defaultTerminalInvocation(platform, directory)).toEqual(expected);
  });

  test("recreates a window on macOS activation only when none remain", () => {
    const createWindow = vi.fn();
    handleDesktopActivate({ windowCount: 1, createWindow });
    handleDesktopActivate({ windowCount: 0, createWindow });
    expect(createWindow).toHaveBeenCalledTimes(1);
  });

  test("delays application quit until the managed Host has stopped", async () => {
    let releaseStop: (() => void) | undefined;
    const stopBackend = vi.fn(() => new Promise<void>((resolve) => (releaseStop = resolve)));
    const quit = vi.fn();
    const preventDefault = vi.fn();
    const handler = createBeforeQuitHandler({ stopBackend, quit });

    handler({ preventDefault });
    handler({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(stopBackend).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    releaseStop?.();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));

    // The second app.quit() emits before-quit again and must be allowed through.
    handler({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });
});

describe("Desktop navigation boundary", () => {
  test("denies popups and opens only HTTP(S) targets outside Electron", () => {
    let openHandler: ((details: { url: string }) => { action: "deny" }) | undefined;
    let navigateHandler: ((event: { preventDefault(): void }, url: string) => void) | undefined;
    const openExternal = vi.fn();
    installWebNavigationPolicy({
      webContents: {
        setWindowOpenHandler: (handler) => (openHandler = handler),
        on: (_event, handler) => (navigateHandler = handler),
      },
      appEntryUrl: "https://opengui.local",
      openExternal,
    });

    expect(openHandler?.({ url: "https://docs.example" })).toEqual({ action: "deny" });
    expect(openHandler?.({ url: "file:///tmp/secret" })).toEqual({ action: "deny" });
    const blocked = { preventDefault: vi.fn() };
    navigateHandler?.(blocked, "https://evil.example");
    const allowed = { preventDefault: vi.fn() };
    navigateHandler?.(allowed, "https://opengui.local/project");

    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(openExternal).toHaveBeenNthCalledWith(1, "https://docs.example");
    expect(openExternal).toHaveBeenNthCalledWith(2, "https://evil.example");
    expect(blocked.preventDefault).toHaveBeenCalledOnce();
    expect(allowed.preventDefault).not.toHaveBeenCalled();
  });

  test.each([
    ["https://opengui.local/project", "https://opengui.local", true],
    ["https://opengui.local.evil.test", "https://opengui.local", false],
    ["file:///app/dist/index.html?detach=x", "file:///app/dist/index.html", true],
    ["file:///home/person/secrets.txt", "file:///app/dist/index.html", false],
  ])("classifies %s against %s", (requested, entrypoint, expected) => {
    expect(isAllowedAppNavigation(requested, entrypoint)).toBe(expected);
  });

  test.each([
    ["https://example.com", true],
    ["http://example.com", true],
    ["file:///tmp/a", false],
    ["https-not-a-url", false],
    [null, false],
  ])("recognizes external web URL %j", (url, expected) => {
    expect(isWebUrl(url)).toBe(expected);
  });
});
