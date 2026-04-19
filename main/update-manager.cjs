const { app, ipcMain, BrowserWindow } = require("electron");

let autoUpdater = null;

const SUPPORTED_PLATFORMS = new Set(["win32", "darwin"]);
const STARTUP_CHECK_DELAY_MS = 10000;

/** @type {UpdateState} */
let state = {
	status: "idle",
	platformSupported: SUPPORTED_PLATFORMS.has(process.platform),
	currentVersion: app.getVersion(),
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
};

let checkTimer = null;
let initialized = false;

function normalizeReleaseNotes(notes) {
	if (typeof notes === "string") return notes.trim() || null;
	if (Array.isArray(notes)) {
		return notes
			.map((entry) => {
				if (!entry) return "";
				if (typeof entry === "string") return entry;
				if (typeof entry.note === "string") return entry.note;
				return "";
			})
			.filter(Boolean)
			.join("\n\n") || null;
	}
	return null;
}

function toIsoDate(value) {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getReleaseUrl(info) {
	if (typeof info?.releaseUrl === "string" && info.releaseUrl) {
		return info.releaseUrl;
	}
	if (typeof info?.files?.[0]?.url === "string") return null;
	return null;
}

function setState(patch) {
	state = { ...state, ...patch };
	broadcastState();
}

function broadcastState() {
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) {
			win.webContents.send("updates:state-changed", state);
		}
	}
}

function applyUpdateInfo(info, extra = {}) {
	setState({
		latestVersion: info?.version ?? state.latestVersion,
		releaseDate: toIsoDate(info?.releaseDate) ?? state.releaseDate,
		releaseNotes: normalizeReleaseNotes(info?.releaseNotes),
		releaseName: typeof info?.releaseName === "string" ? info.releaseName : null,
		releaseUrl: getReleaseUrl(info),
		updateInfoFetched: true,
		...extra,
	});
}

function getState() {
	return state;
}

function isSupportedRuntime() {
	return app.isPackaged && SUPPORTED_PLATFORMS.has(process.platform);
}

async function checkForUpdates() {
	if (!isSupportedRuntime()) {
		setState({
			status: "disabled",
			errorMessage: null,
			platformSupported: SUPPORTED_PLATFORMS.has(process.platform),
		});
		return state;
	}

	if (!loadAutoUpdater()) {
		return state;
	}

	setState({
		status: "checking",
		errorMessage: null,
		downloaded: false,
		progressPercent: null,
		bytesPerSecond: null,
		transferred: null,
		total: null,
	});

	try {
		await autoUpdater.checkForUpdates();
	} catch (error) {
		setState({
			status: "error",
			errorMessage: error instanceof Error ? error.message : String(error),
		});
	}
	return state;
}

async function downloadUpdate() {
	if (!isSupportedRuntime()) return state;
	const updater = loadAutoUpdater();
	if (!updater) return state;
	try {
		await updater.downloadUpdate();
	} catch (error) {
		setState({
			status: "error",
			errorMessage: error instanceof Error ? error.message : String(error),
		});
	}
	return state;
}

function installUpdate() {
	if (!isSupportedRuntime()) return false;
	const updater = loadAutoUpdater();
	if (!updater) return false;
	setState({ status: "installing", errorMessage: null });
	setImmediate(() => {
		updater.quitAndInstall(false, true);
	});
	return true;
}

function loadAutoUpdater() {
	if (autoUpdater) return autoUpdater;
	try {
		({ autoUpdater } = require("electron-updater"));
	} catch (error) {
		setState({
			status: "disabled",
			errorMessage:
				error instanceof Error ? error.message : String(error),
			platformSupported: SUPPORTED_PLATFORMS.has(process.platform),
		});
		return null;
	}
	return autoUpdater;
}

function setupAutoUpdater() {
	if (initialized) return;
	initialized = true;

	const updater = loadAutoUpdater();
	if (!updater) return;

	updater.autoDownload = true;
	updater.autoInstallOnAppQuit = true;
	updater.autoRunAppAfterInstall = true;
	updater.allowPrerelease = false;
	if (process.platform === "darwin") {
		updater.allowDowngrade = false;
	}

	updater.on("checking-for-update", () => {
		setState({ status: "checking", errorMessage: null });
	});

	updater.on("update-available", (info) => {
		applyUpdateInfo(info, {
			status: "available",
			errorMessage: null,
			downloaded: false,
		});
	});

	updater.on("update-not-available", (info) => {
		applyUpdateInfo(info, {
			status: "not-available",
			errorMessage: null,
			downloaded: false,
		});
	});

	updater.on("download-progress", (progress) => {
		setState({
			status: "downloading",
			progressPercent: progress.percent,
			bytesPerSecond: progress.bytesPerSecond,
			transferred: progress.transferred,
			total: progress.total,
			errorMessage: null,
		});
	});

	updater.on("update-downloaded", (info) => {
		applyUpdateInfo(info, {
			status: "downloaded",
			downloaded: true,
			progressPercent: 100,
			errorMessage: null,
		});
	});

	updater.on("error", (error) => {
		setState({
			status: "error",
			errorMessage: error == null ? "Unknown update error" : error.message,
		});
	});
}

function setupUpdateManager() {
	if (isSupportedRuntime()) {
		setupAutoUpdater();
	} else {
		setState({
			status: "disabled",
			errorMessage: null,
			platformSupported: SUPPORTED_PLATFORMS.has(process.platform),
		});
	}

	ipcMain.handle("updates:getState", () => state);
	ipcMain.handle("updates:check", () => checkForUpdates());
	ipcMain.handle("updates:download", () => downloadUpdate());
	ipcMain.handle("updates:install", () => installUpdate());

	if (checkTimer) clearTimeout(checkTimer);
	checkTimer = setTimeout(() => {
		void checkForUpdates();
	}, STARTUP_CHECK_DELAY_MS);
}

module.exports = {
	setupUpdateManager,
	getUpdateState: getState,
};

/**
 * @typedef {Object} UpdateState
 * @property {"idle"|"checking"|"available"|"downloading"|"downloaded"|"not-available"|"error"|"installing"|"disabled"} status
 * @property {boolean} platformSupported
 * @property {string} currentVersion
 * @property {string | null} latestVersion
 * @property {string | null} releaseDate
 * @property {string | null} releaseNotes
 * @property {string | null} releaseName
 * @property {string | null} releaseUrl
 * @property {number | null} progressPercent
 * @property {number | null} bytesPerSecond
 * @property {number | null} transferred
 * @property {number | null} total
 * @property {string | null} errorMessage
 * @property {boolean} downloaded
 * @property {boolean} autoDownload
 * @property {boolean} updateInfoFetched
 */
