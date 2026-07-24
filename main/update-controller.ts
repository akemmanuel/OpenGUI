import type { AppUpdateState } from "../src/types/shell.js";

interface UpdateInfoLike {
  version?: string;
  releaseDate?: string;
  releaseName?: string;
  releaseNotes?: string | Array<unknown> | null;
}

interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

function initialState(currentVersion: string, supported: boolean): AppUpdateState {
  return {
    status: supported ? "idle" : "disabled",
    platformSupported: supported,
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
    autoDownload: false,
    updateInfoFetched: false,
  };
}

export function createDesktopUpdateController(input: {
  updater: UpdaterLike;
  currentVersion: string;
  isPackaged: boolean;
  platform: NodeJS.Platform | (string & {});
  publish(state: AppUpdateState): void;
}) {
  const supported =
    input.isPackaged &&
    (input.platform === "darwin" ||
      input.platform === "win32" ||
      (input.platform === "linux" && Boolean(process.env.APPIMAGE)));
  let state = initialState(input.currentVersion, supported);
  input.updater.autoDownload = false;
  input.updater.autoInstallOnAppQuit = true;

  const update = (patch: Partial<AppUpdateState>) => {
    state = { ...state, ...patch };
    input.publish({ ...state });
  };
  const infoPatch = (info: UpdateInfoLike): Partial<AppUpdateState> => ({
    latestVersion: info.version ?? state.latestVersion,
    releaseDate: info.releaseDate ?? state.releaseDate,
    releaseName: info.releaseName ?? state.releaseName,
    releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : state.releaseNotes,
    updateInfoFetched: true,
  });

  input.updater.on("checking-for-update", () => update({ status: "checking", errorMessage: null }));
  input.updater.on("update-available", (info: UpdateInfoLike) =>
    update({ ...infoPatch(info), status: "available", downloaded: false, errorMessage: null }),
  );
  input.updater.on("update-not-available", (info: UpdateInfoLike) =>
    update({ ...infoPatch(info), status: "not-available", downloaded: false }),
  );
  input.updater.on(
    "download-progress",
    (progress: {
      percent?: number;
      bytesPerSecond?: number;
      transferred?: number;
      total?: number;
    }) =>
      update({
        status: "downloading",
        progressPercent: progress.percent ?? null,
        bytesPerSecond: progress.bytesPerSecond ?? null,
        transferred: progress.transferred ?? null,
        total: progress.total ?? null,
      }),
  );
  input.updater.on("update-downloaded", (info: UpdateInfoLike) =>
    update({
      ...infoPatch(info),
      status: "downloaded",
      progressPercent: 100,
      downloaded: true,
    }),
  );
  input.updater.on("error", (error: Error) =>
    update({ status: "error", errorMessage: error.message || String(error) }),
  );

  return {
    getState: () => ({ ...state }),
    async check() {
      if (!supported) return { ...state };
      update({ status: "checking", errorMessage: null });
      try {
        await input.updater.checkForUpdates();
      } catch (error) {
        update({
          status: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
      return { ...state };
    },
    async download() {
      if (!supported || !state.latestVersion) return { ...state };
      update({ status: "downloading", errorMessage: null });
      try {
        await input.updater.downloadUpdate();
      } catch (error) {
        update({
          status: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
      return { ...state };
    },
    async install() {
      if (!supported || !state.downloaded) return false;
      update({ status: "installing" });
      input.updater.quitAndInstall(false, true);
      return true;
    },
  };
}
