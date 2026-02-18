const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron/main");
const path = require("node:path");
const { execSync, spawn } = require("node:child_process");

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

// Open a directory in the system file browser
ipcMain.handle("shell:openInFileBrowser", (_event, dirPath) => {
	if (typeof dirPath === "string" && dirPath.length > 0) {
		shell.openPath(dirPath);
	}
});

// Open a terminal at a directory (cross-platform)
ipcMain.handle("shell:openInTerminal", (_event, dirPath) => {
	if (typeof dirPath !== "string" || dirPath.length === 0) return;
	const platform = process.platform;
	const spawnOpts = { detached: true, stdio: "ignore", cwd: dirPath };
	if (platform === "darwin") {
		spawn("open", ["-a", "Terminal", dirPath], spawnOpts);
	} else if (platform === "win32") {
		spawn("cmd.exe", ["/c", "start", "cmd.exe", "/k", `cd /d "${dirPath}"`], {
			...spawnOpts,
			shell: true,
		});
	} else {
		// Linux: respect the desktop environment's preferred terminal.
		// Query gsettings for Cinnamon / GNOME default terminal, then
		// fall back to $TERMINAL, x-terminal-emulator, and known terminals.
		const gsettingsKeys = [
			"org.cinnamon.desktop.default-applications.terminal exec",
			"org.gnome.desktop.default-applications.terminal exec",
		];
		let deTerminal = null;
		for (const key of gsettingsKeys) {
			try {
				const raw = execSync(`gsettings get ${key}`, {
					encoding: "utf-8",
					timeout: 2000,
					stdio: ["ignore", "pipe", "ignore"],
				}).trim();
				// gsettings returns values like 'gnome-terminal' (with quotes)
				const val = raw.replace(/^'|'$/g, "");
				if (val && val !== "x-terminal-emulator") {
					deTerminal = val;
					break;
				}
			} catch {
				// gsettings schema not available, try next
			}
		}

		const terminals = [];
		if (deTerminal) terminals.push([deTerminal]);
		if (process.env.TERMINAL) terminals.push([process.env.TERMINAL]);
		terminals.push(
			["x-terminal-emulator"],
			["gnome-terminal", "--working-directory", dirPath],
			["konsole", "--workdir", dirPath],
			["xfce4-terminal", "--working-directory", dirPath],
			["alacritty", "--working-directory", dirPath],
			["kitty", "-d", dirPath],
			["wezterm", "start", "--cwd", dirPath],
			["xterm"],
		);
		// Try sequentially; spawn emits 'error' when the command is not
		// found so we move on to the next candidate.
		const tryTerminal = (index) => {
			if (index >= terminals.length) return;
			const [cmd, ...args] = terminals[index];
			const child = spawn(cmd, args, spawnOpts);
			child.on("error", () => tryTerminal(index + 1));
			child.unref();
		};
		tryTerminal(0);
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
