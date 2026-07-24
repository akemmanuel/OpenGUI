// @vitest-environment happy-dom

import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { DesktopShellProvider } from "@/shell/provider";
import type { AppUpdateState } from "@/types/shell";
import { useUpdateCheck } from "./use-update-check";

const currentVersion = "0.5.27";

function state(overrides: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    status: "idle",
    platformSupported: true,
    currentVersion,
    latestVersion: null,
    releaseDate: null,
    releaseNotes: null,
    releaseName: null,
    releaseUrl: null,
    progressPercent: null,
    bytesPerSecond: null,
    transferred: null,
    total: null,
    errorMessage: null,
    downloaded: false,
    autoDownload: true,
    updateInfoFetched: false,
    ...overrides,
  };
}

function shellWith(updates: Record<string, unknown>) {
  return { updates } as never;
}

function wrapper(shell: never) {
  return ({ children }: { children: ReactNode }) => (
    <DesktopShellProvider shell={shell}>{children}</DesktopShellProvider>
  );
}

describe("update checks", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });
  afterEach(() => vi.restoreAllMocks());

  test("discovers and dismisses a newer browser release", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ tag_name: "v9.1.0", html_url: "https://release", body: "fixes" }),
            {
              status: 200,
            },
          ),
      ),
    );
    const updates = {
      isManaged: false,
      getState: vi.fn(),
      onStateChanged: vi.fn(),
      check: vi.fn(),
      download: vi.fn(),
      install: vi.fn(),
    };
    const { result, unmount } = renderHook(() => useUpdateCheck(), {
      wrapper: wrapper(shellWith(updates)),
    });

    await waitFor(() => expect(result.current.status).toBe("available"));
    expect(result.current).toMatchObject({
      updateAvailable: true,
      latestVersion: "9.1.0",
      releaseUrl: "https://release",
      isElectronManaged: false,
    });
    act(() => result.current.dismiss());
    expect(result.current.updateAvailable).toBe(false);
    unmount();
  });

  test("subscribes to managed progress and delegates check, download, install, and cleanup", async () => {
    let listener: ((next: AppUpdateState) => void) | undefined;
    const remove = vi.fn();
    const updates = {
      isManaged: true,
      getState: vi.fn(async () => state()),
      onStateChanged: vi.fn((next) => {
        listener = next;
        return remove;
      }),
      check: vi.fn(async () => state({ status: "available", latestVersion: "2.0.0" })),
      download: vi.fn(async () =>
        state({ status: "downloaded", latestVersion: "2.0.0", downloaded: true }),
      ),
      install: vi.fn(async () => undefined),
    };
    const { result, unmount } = renderHook(() => useUpdateCheck(), {
      wrapper: wrapper(shellWith(updates)),
    });
    await waitFor(() => expect(updates.getState).toHaveBeenCalled());

    await act(() => result.current.checkNow());
    expect(result.current.updateAvailable).toBe(true);
    act(() =>
      listener?.(state({ status: "downloading", latestVersion: "2.0.0", progressPercent: 42 })),
    );
    expect(result.current.progressPercent).toBe(42);
    await act(() => result.current.download());
    expect(result.current.canDismiss).toBe(false);
    await act(() => result.current.install());
    expect(updates.install).toHaveBeenCalledOnce();
    unmount();
    expect(remove).toHaveBeenCalledOnce();
  });

  test("reports browser HTTP failures without advertising an update", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 })),
    );
    const updates = { isManaged: false };
    const { result } = renderHook(() => useUpdateCheck(), {
      wrapper: wrapper(shellWith(updates)),
    });
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.errorMessage).toBe("Update check failed: 503");
    expect(result.current.updateAvailable).toBe(false);
  });
});
