// @vitest-environment happy-dom

import { afterEach, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { polyfillLocalStorage } from "@/lib/__tests__/setup";

const policy = vi.hoisted(() => ({ authToken: "host-token" as string | undefined }));
vi.mock("@/runtime/shell-policy", () => ({
  getShellWorkspacePolicy: () => ({ configuredWebWorkspace: { authToken: policy.authToken } }),
}));

import { installWebElectronAPI } from "./web-electron-api";

beforeAll(polyfillLocalStorage);

afterEach(() => {
  delete window.electronAPI;
  delete window.Capacitor;
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  policy.authToken = "host-token";
});

describe("installWebElectronAPI", () => {
  test("installs the web Shell once and synchronizes setting changes", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch);
    const changed = vi.fn();

    installWebElectronAPI();
    const api = window.electronAPI!;
    const unsubscribe = api.settings.onDidChange(changed);
    expect(api.kind).toBe("web");
    expect(api.settings.setSync("theme", "dark")).toBe(true);
    expect(api.settings.getSync("theme")).toBe("dark");
    expect(changed).toHaveBeenCalledWith({ key: "theme", value: "dark" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const request = fetch.mock.calls[0]?.[1];
    expect(request).toMatchObject({ method: "POST" });
    expect((request!.headers as Headers).get("authorization")).toBe("Bearer host-token");

    unsubscribe();
    api.settings.removeSync("theme");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  test("does not replace desktop, file, or native-mobile bridges", () => {
    const existing = { kind: "desktop" } as unknown as typeof window.electronAPI;
    window.electronAPI = existing;
    installWebElectronAPI();
    expect(window.electronAPI).toBe(existing);

    delete window.electronAPI;
    window.Capacitor = { isNativePlatform: () => true };
    installWebElectronAPI();
    expect(window.electronAPI).toBeUndefined();
  });

  test("surfaces rejected RPC responses through the public method", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ ok: false, error: "not allowed" }),
      }),
    );
    installWebElectronAPI();
    const getHomeDir = window.electronAPI!.getHomeDir;
    expect(getHomeDir).toBeTypeOf("function");
    await expect(getHomeDir!()).rejects.toThrow("not allowed");
  });
});
