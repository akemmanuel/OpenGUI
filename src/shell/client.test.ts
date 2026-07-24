import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { ElectronAPI } from "@/types/preload-api";
import { createElectronDesktopShell, createWebDesktopShell } from "./client";

afterEach(() => vi.unstubAllGlobals());

describe("Desktop Shell clients", () => {
  test("the web Shell exposes safe browser behavior without desktop capabilities", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", {
      open,
      location: { search: "?detach=%2Fwork%2Fdemo" },
    });
    vi.stubGlobal("navigator", { language: "de-DE" });
    const shell = createWebDesktopShell();

    expect(shell.runtime.isElectron).toBe(false);
    expect(shell.backend).toBeUndefined();
    expect(shell.detachedProjects.getCurrent()).toBe("/work/demo");
    expect(await shell.dialog.openDirectory()).toBeNull();
    expect(await shell.platform.getPlatform()).toBe("web");
    expect(await shell.platform.getSystemLocale()).toBe("de-DE");
    expect((await shell.updates.check()).status).toBe("disabled");

    await shell.navigation.openExternal("https://docs.example/path");
    expect(open).toHaveBeenCalledWith("https://docs.example/path", "_blank", "noopener,noreferrer");
  });

  test("the Electron Shell filters raw backend events and closes its stream", () => {
    const streams: FakeEventSource[] = [];
    class FakeEventSource {
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      closed = false;

      constructor(readonly url: string) {
        streams.push(this);
      }

      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const api = {
      kind: "electron",
      backendUrl: "http://127.0.0.1:4567/base",
      backendToken: "token with spaces",
    } as ElectronAPI;
    const listener = vi.fn();
    const shell = createElectronDesktopShell(api);

    const unsubscribe = shell.events.onBackendChannel("session:event", listener);
    expect(streams[0]?.url).toBe("http://127.0.0.1:4567/api/events?token=token+with+spaces");
    streams[0]?.onmessage?.({
      data: JSON.stringify({ channel: "other", data: "ignored" }),
    } as MessageEvent<string>);
    streams[0]?.onmessage?.({
      data: JSON.stringify({ channel: "session:event", data: { id: "session-1" } }),
    } as MessageEvent<string>);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ id: "session-1" });
    unsubscribe();
    expect(streams[0]?.closed).toBe(true);
  });
});
