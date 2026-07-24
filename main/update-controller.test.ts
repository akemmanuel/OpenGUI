import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vite-plus/test";
import { createDesktopUpdateController } from "./update-controller";

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  checkForUpdates = vi.fn(async () => null);
  downloadUpdate = vi.fn(async () => []);
  quitAndInstall = vi.fn();
}

describe("Desktop update lifecycle", () => {
  test("stays disabled outside a supported packaged runtime", async () => {
    const updater = new FakeUpdater();
    const controller = createDesktopUpdateController({
      updater: updater as never,
      currentVersion: "1.2.3",
      isPackaged: false,
      platform: "linux",
      publish: vi.fn(),
    });
    expect(await controller.check()).toMatchObject({
      status: "disabled",
      platformSupported: false,
    });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  test("projects available, progress, downloaded, and install events", async () => {
    const updater = new FakeUpdater();
    const publish = vi.fn();
    const controller = createDesktopUpdateController({
      updater: updater as never,
      currentVersion: "1.2.3",
      isPackaged: true,
      platform: "win32",
      publish,
    });
    updater.emit("update-available", {
      version: "2.0.0",
      releaseDate: "2026-01-01",
      releaseName: "Stable",
      releaseNotes: "Fixes",
    });
    updater.emit("download-progress", {
      percent: 42,
      bytesPerSecond: 100,
      transferred: 4,
      total: 10,
    });
    updater.emit("update-downloaded", { version: "2.0.0" });

    expect(controller.getState()).toMatchObject({
      status: "downloaded",
      latestVersion: "2.0.0",
      progressPercent: 100,
      downloaded: true,
    });
    expect(publish).toHaveBeenCalledTimes(3);
    await expect(controller.install()).resolves.toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });

  test("reports check failures and supports explicit download", async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates.mockRejectedValueOnce(new Error("offline"));
    const controller = createDesktopUpdateController({
      updater: updater as never,
      currentVersion: "1.2.3",
      isPackaged: true,
      platform: "darwin",
      publish: vi.fn(),
    });
    await expect(controller.check()).resolves.toMatchObject({
      status: "error",
      errorMessage: "offline",
    });
    updater.emit("update-available", { version: "2.0.0" });
    await expect(controller.download()).resolves.toMatchObject({ status: "downloading" });
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
  });

  test("fails closed before availability/download and normalizes non-Error download failures", async () => {
    const updater = new FakeUpdater();
    const controller = createDesktopUpdateController({
      updater: updater as never,
      currentVersion: "1.2.3",
      isPackaged: true,
      platform: "darwin",
      publish: vi.fn(),
    });

    expect(await controller.download()).toMatchObject({ status: "idle", latestVersion: null });
    await expect(controller.install()).resolves.toBe(false);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();

    updater.emit("update-available", {
      version: "2.0.0",
      releaseNotes: [{ version: "ignored structured notes" }],
    });
    updater.downloadUpdate.mockRejectedValueOnce("offline proxy");
    await expect(controller.download()).resolves.toMatchObject({
      status: "error",
      errorMessage: "offline proxy",
      releaseNotes: null,
    });
  });
});
