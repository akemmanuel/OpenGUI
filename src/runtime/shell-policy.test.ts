import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { getShellWorkspacePolicy } from "./shell-policy";

const originalWindow = globalThis.window;
const originalNavigator = globalThis.navigator;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalWindow) vi.stubGlobal("window", originalWindow);
  if (originalNavigator) vi.stubGlobal("navigator", originalNavigator);
});

function browser(options: {
  userAgent?: string;
  origin?: string;
  nativeMobile?: boolean;
  config?: Record<string, string>;
}) {
  vi.stubGlobal("navigator", {
    userAgent: options.userAgent ?? "Mozilla/5.0",
    language: "en-US",
  });
  vi.stubGlobal("window", {
    location: { origin: options.origin ?? "https://app.example" },
    Capacitor: options.nativeMobile
      ? { isNativePlatform: () => true }
      : { isNativePlatform: () => false },
    __OPENGUI_CONFIG__: options.config,
  });
}

describe("Shell workspace policy", () => {
  test("keeps Desktop projects local while allowing additional Host workspaces", () => {
    browser({ userAgent: "OpenGUI Electron/43.0" });

    expect(getShellWorkspacePolicy()).toEqual({
      shellKind: "desktop",
      supportsMultipleWorkspaces: true,
      localWorkspaceMode: "desktop-local",
      configuredWebWorkspace: null,
    });
  });

  test("does not claim a device-local Host on native mobile", () => {
    browser({ nativeMobile: true });

    expect(getShellWorkspacePolicy()).toEqual({
      shellKind: "mobile",
      supportsMultipleWorkspaces: true,
      localWorkspaceMode: "none",
      configuredWebWorkspace: null,
    });
  });

  test("uses trimmed runtime Host configuration for the single web workspace", () => {
    browser({
      origin: "https://fallback.example",
      config: {
        OPENGUI_BASE_URL: "  https://host.example/// ",
        OPENGUI_WORKSPACE_NAME: "  Team Host  ",
        OPENGUI_AUTH_TOKEN: "  host-secret  ",
      },
    });

    expect(getShellWorkspacePolicy()).toEqual({
      shellKind: "web",
      supportsMultipleWorkspaces: false,
      localWorkspaceMode: "web-local",
      configuredWebWorkspace: {
        baseUrl: "https://host.example",
        name: "Team Host",
        authToken: "host-secret",
      },
    });
  });
});
