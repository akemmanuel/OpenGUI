const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron/main");
const path = require("node:path");
const { execSync, spawn } = require("node:child_process");
const { createSettingsStore } = require("./settings-store.cjs");

app.setName("OpenGUI");
app.setPath("userData", path.join(app.getPath("appData"), "OpenGUI"));

const DEV_SERVER_URL =
	process.env.BUN_DEV_SERVER_URL || "http://localhost:3000";
const isDev = !app.isPackaged && process.env.NODE_ENV !== "production";
const settingsStore = createSettingsStore(app.getPath("userData"));

let mainWindow = null;

function broadcastSettingsChange(key, value) {
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) {
			win.webContents.send("settings:changed", { key, value });
		}
	}
}

function parseCommand(command) {
	if (typeof command !== "string") return [];
	const matches = command.match(/"[^"]*"|'[^']*'|\S+/g);
	if (!matches) return [];
	return matches.map((part) => part.replace(/^['"]|['"]$/g, ""));
}

function spawnCustomCommand(command, options = {}) {
	const parts = parseCommand(command);
	if (parts.length === 0) return false;
	const [cmd, ...args] = parts;
	const child = spawn(cmd, args, options);
	child.on("error", () => {});
	child.unref();
	return true;
}

/** Check if a URL uses a web protocol (http/https). */
function isWebUrl(url) {
	return (
		typeof url === "string" &&
		(url.startsWith("https://") || url.startsWith("http://"))
	);
}

function createBrowserWindow({
	width,
	height,
	minWidth = 450,
	minHeight = 500,
}) {
	const isMac = process.platform === "darwin";

	const win = new BrowserWindow({
		width,
		height,
		minWidth,
		minHeight,
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

	// Intercept all external link navigations and open them in the system browser.
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (isWebUrl(url)) shell.openExternal(url);
		return { action: "deny" };
	});

	win.webContents.on("will-navigate", (event, url) => {
		const appOrigins = [DEV_SERVER_URL, "file://"];
		const isInternal = appOrigins.some((origin) => url.startsWith(origin));
		if (!isInternal) {
			event.preventDefault();
			if (isWebUrl(url)) shell.openExternal(url);
		}
	});

	win.on("maximize", () => {
		win.webContents.send("window:maximizeChanged", true);
	});

	win.on("unmaximize", () => {
		win.webContents.send("window:maximizeChanged", false);
	});

	return win;
}

function createWindow() {
	mainWindow = createBrowserWindow({ width: 1200, height: 800 });

	if (isDev) {
		void mainWindow.loadURL(DEV_SERVER_URL);
	} else {
		void mainWindow.loadFile(path.join(__dirname, "dist", "index.html"));
	}

	mainWindow.once("ready-to-show", () => {
		mainWindow.show();
	});
}

/** Track detached project windows so we can detect duplicates and clean up. */
const detachedWindows = new Map(); // projectDir -> BrowserWindow

function getDetachedProjectDirectories() {
	return Array.from(detachedWindows.entries())
		.filter(([, win]) => win && !win.isDestroyed())
		.map(([projectDir]) => projectDir);
}

function broadcastDetachedProjects() {
	const detachedProjects = getDetachedProjectDirectories();
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) {
			win.webContents.send("window:detachedProjectsChanged", detachedProjects);
		}
	}
}

function createProjectWindow(projectDir) {
	// Reuse existing detached window if one already exists for this project
	const existing = detachedWindows.get(projectDir);
	if (existing && !existing.isDestroyed()) {
		existing.focus();
		broadcastDetachedProjects();
		return;
	}

	const win = createBrowserWindow({ width: 900, height: 700 });

	detachedWindows.set(projectDir, win);

	const projectLabel = projectDir.split(/[\\/]/).pop() || projectDir;
	win.setTitle(`OpenGUI - ${projectLabel}`);

	const loadUrl = isDev
		? `${DEV_SERVER_URL}?detach=${encodeURIComponent(projectDir)}`
		: `file://${path.join(__dirname, "dist", "index.html")}?detach=${encodeURIComponent(projectDir)}`;

	void win.loadURL(loadUrl);

	win.once("ready-to-show", () => {
		win.show();
		broadcastDetachedProjects();
	});

	win.on("closed", () => {
		detachedWindows.delete(projectDir);
		broadcastDetachedProjects();
	});

	return win;
}

// IPC handlers
ipcMain.on("settings:get-all-sync", (event) => {
	event.returnValue = settingsStore.getAll();
});

ipcMain.on("settings:get-sync", (event, key) => {
	event.returnValue = settingsStore.get(key);
});

ipcMain.on("settings:set-sync", (event, key, value) => {
	const success = settingsStore.set(key, value);
	if (success) broadcastSettingsChange(key, value);
	event.returnValue = success;
});

ipcMain.on("settings:remove-sync", (event, key) => {
	const success = settingsStore.remove(key);
	if (success) broadcastSettingsChange(key, null);
	event.returnValue = success;
});

ipcMain.on("settings:merge-sync", (event, entries) => {
	let success = false;
	if (entries && typeof entries === "object" && !Array.isArray(entries)) {
		success = settingsStore.merge(entries);
		if (success) {
			for (const [key, value] of Object.entries(entries)) {
				if (typeof key === "string" && typeof value === "string") {
					broadcastSettingsChange(key, value);
				}
			}
		}
	}
	event.returnValue = success;
});

ipcMain.handle("settings:set", (_event, key, value) => {
	const success = settingsStore.set(key, value);
	if (success) broadcastSettingsChange(key, value);
	return success;
});

ipcMain.handle("settings:remove", (_event, key) => {
	const success = settingsStore.remove(key);
	if (success) broadcastSettingsChange(key, null);
	return success;
});

ipcMain.handle("window:minimize", (event) => {
	BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.handle("window:maximize", (event) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (win?.isMaximized()) {
		win.unmaximize();
	} else {
		win?.maximize();
	}
});

ipcMain.handle("window:close", (event) => {
	BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.handle("window:isMaximized", (event) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	return win?.isMaximized() ?? false;
});

ipcMain.handle("window:detachProject", (_event, projectDir) => {
	if (typeof projectDir !== "string" || projectDir.length === 0) return;
	createProjectWindow(projectDir);
});

ipcMain.handle("window:getDetachedProjects", () => {
	return getDetachedProjectDirectories();
});

ipcMain.handle("platform:get", () => {
	return process.platform;
});

ipcMain.handle("platform:homeDir", () => {
	return require("node:os").homedir();
});

// Open a URL in the system browser (not in Electron)
ipcMain.handle("shell:openExternal", (_event, url) => {
	if (isWebUrl(url)) shell.openExternal(url);
});

// Open a directory in the system file browser
ipcMain.handle("shell:openInFileBrowser", (_event, dirPath, command = "") => {
	if (typeof dirPath !== "string" || dirPath.length === 0) return;
	const spawnOpts = { detached: true, stdio: "ignore", cwd: dirPath };
	const parts = parseCommand(command);
	if (parts.length > 0) {
		const [cmd, ...args] = parts;
		const child = spawn(cmd, args.length > 0 ? args : [dirPath], spawnOpts);
		child.on("error", () => {
			shell.openPath(dirPath);
		});
		child.unref();
		return;
	}
	shell.openPath(dirPath);
});

// Open a terminal at a directory (cross-platform)
ipcMain.handle("shell:openInTerminal", (_event, dirPath, command = "") => {
	if (typeof dirPath !== "string" || dirPath.length === 0) return;
	const platform = process.platform;
	const spawnOpts = { detached: true, stdio: "ignore", cwd: dirPath };
	if (spawnCustomCommand(command, spawnOpts)) return;
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

ipcMain.handle("dialog:openDirectory", async (event) => {
	const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
	const result = await dialog.showOpenDialog(ownerWindow, {
		properties: ["openDirectory"],
	});
	if (result.canceled || result.filePaths.length === 0) {
		return null;
	}
	return result.filePaths[0] ?? null;
});

void app.whenReady().then(async () => {
	createWindow();

	// Load ESM opencode bridge (SDK is ESM-only)
	try {
		const { setupOpenCodeBridge } = await import("./opencode-bridge.mjs");
		setupOpenCodeBridge(ipcMain, () => BrowserWindow.getAllWindows());
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
