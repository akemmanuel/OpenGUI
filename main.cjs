const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron/main");
const path = require("node:path");

const DEV_SERVER_URL =
	process.env.BUN_DEV_SERVER_URL || "http://localhost:3000";
const isDev = !app.isPackaged && process.env.NODE_ENV !== "production";

let mainWindow = null;

function createWindow() {
	const isMac = process.platform === "darwin";

	mainWindow = new BrowserWindow({
		width: 1200,
		height: 800,
		minWidth: 450,
		minHeight: 500,
		show: false,
		frame: false,
		...(isMac ? { transparent: true } : {}),
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			preload: path.join(__dirname, "preload.cjs"),
		},
		...(!isMac ? { backgroundColor: "#1a1a1a" } : {}),
	});

	if (isDev) {
		mainWindow.loadURL(DEV_SERVER_URL);
	} else {
		mainWindow.loadFile(path.join(__dirname, "dist", "index.html"));
	}

	mainWindow.once("ready-to-show", () => {
		mainWindow.show();
	});

	// Intercept all external link navigations and open them in the system browser.
	// This catches <a target="_blank"> clicks and window.open() calls.
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith("https://") || url.startsWith("http://")) {
			shell.openExternal(url);
		}
		return { action: "deny" };
	});

	// Also intercept in-page navigations to external URLs (e.g. clicking an <a> without target)
	mainWindow.webContents.on("will-navigate", (event, url) => {
		const appOrigins = [DEV_SERVER_URL, "file://"];
		const isInternal = appOrigins.some((origin) => url.startsWith(origin));
		if (!isInternal) {
			event.preventDefault();
			if (url.startsWith("https://") || url.startsWith("http://")) {
				shell.openExternal(url);
			}
		}
	});

	mainWindow.on("maximize", () => {
		mainWindow.webContents.send("window:maximizeChanged", true);
	});

	mainWindow.on("unmaximize", () => {
		mainWindow.webContents.send("window:maximizeChanged", false);
	});
}

// IPC handlers
ipcMain.handle("window:minimize", () => {
	mainWindow?.minimize();
});

ipcMain.handle("window:maximize", () => {
	if (mainWindow?.isMaximized()) {
		mainWindow.unmaximize();
	} else {
		mainWindow?.maximize();
	}
});

ipcMain.handle("window:close", () => {
	mainWindow?.close();
});

ipcMain.handle("window:isMaximized", () => {
	return mainWindow?.isMaximized() ?? false;
});

ipcMain.handle("platform:get", () => {
	return process.platform;
});

ipcMain.handle("platform:homeDir", () => {
	return require("node:os").homedir();
});

// Open a URL in the system browser (not in Electron)
ipcMain.handle("shell:openExternal", (_event, url) => {
	if (
		typeof url === "string" &&
		(url.startsWith("https://") || url.startsWith("http://"))
	) {
		shell.openExternal(url);
	}
});

ipcMain.handle("dialog:openDirectory", async () => {
	const result = await dialog.showOpenDialog(mainWindow, {
		properties: ["openDirectory"],
	});
	if (result.canceled || result.filePaths.length === 0) {
		return null;
	}
	return result.filePaths[0] ?? null;
});

app.whenReady().then(async () => {
	createWindow();

	// Load ESM opencode bridge (SDK is ESM-only)
	try {
		const { setupOpenCodeBridge } = await import("./opencode-bridge.mjs");
		setupOpenCodeBridge(ipcMain, () => mainWindow);
	} catch (err) {
		console.error("Failed to load opencode bridge:", err);
	}

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});
