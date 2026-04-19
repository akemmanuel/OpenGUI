const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
	settings: {
		getAllSync: () => ipcRenderer.sendSync("settings:get-all-sync"),
		getSync: (key) => ipcRenderer.sendSync("settings:get-sync", key),
		setSync: (key, value) => ipcRenderer.sendSync("settings:set-sync", key, value),
		removeSync: (key) => ipcRenderer.sendSync("settings:remove-sync", key),
		mergeSync: (entries) => ipcRenderer.sendSync("settings:merge-sync", entries),
		set: (key, value) => ipcRenderer.invoke("settings:set", key, value),
		remove: (key) => ipcRenderer.invoke("settings:remove", key),
		onDidChange: (callback) => {
			const handler = (_event, change) => callback(change);
			ipcRenderer.on("settings:changed", handler);
			return () => ipcRenderer.removeListener("settings:changed", handler);
		},
	},

	// Window controls
	minimize: () => ipcRenderer.invoke("window:minimize"),
	maximize: () => ipcRenderer.invoke("window:maximize"),
	close: () => ipcRenderer.invoke("window:close"),
	isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
	getPlatform: () => ipcRenderer.invoke("platform:get"),
	onMaximizeChange: (callback) => {
		const handler = (_event, isMaximized) => callback(isMaximized);
		ipcRenderer.on("window:maximizeChanged", handler);
		return () => ipcRenderer.removeListener("window:maximizeChanged", handler);
	},

	// Directory picker
	openDirectory: () => ipcRenderer.invoke("dialog:openDirectory"),

	// Detach a project into its own window
	detachProject: (projectDir) =>
		ipcRenderer.invoke("window:detachProject", projectDir),

	// Get the detached project directory from the URL query param (empty if not detached)
	getDetachedProject: () => {
		const params = new URLSearchParams(window.location.search);
		return params.get("detach") || null;
	},
	getDetachedProjects: () => ipcRenderer.invoke("window:getDetachedProjects"),
	onDetachedProjectsChange: (callback) => {
		const handler = (_event, detachedProjects) => callback(detachedProjects);
		ipcRenderer.on("window:detachedProjectsChanged", handler);
		return () =>
			ipcRenderer.removeListener("window:detachedProjectsChanged", handler);
	},

	// Open a URL in the system browser
	openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),

	updates: {
		getState: () => ipcRenderer.invoke("updates:getState"),
		check: () => ipcRenderer.invoke("updates:check"),
		download: () => ipcRenderer.invoke("updates:download"),
		install: () => ipcRenderer.invoke("updates:install"),
		onStateChanged: (callback) => {
			const handler = (_event, nextState) => callback(nextState);
			ipcRenderer.on("updates:state-changed", handler);
			return () => ipcRenderer.removeListener("updates:state-changed", handler);
		},
	},

	// Open a directory in the system file browser
	openInFileBrowser: (dirPath, command = "") =>
		ipcRenderer.invoke("shell:openInFileBrowser", dirPath, command),

	// Open a terminal at a directory
	openInTerminal: (dirPath, command = "") =>
		ipcRenderer.invoke("shell:openInTerminal", dirPath, command),

	// Home directory (for path abbreviation)
	getHomeDir: () => ipcRenderer.invoke("platform:homeDir"),

	// Worktree setup helpers
	worktree: {
		detectSetup: (worktreePath) =>
			ipcRenderer.invoke("worktree:detect-setup", worktreePath),
		runSetup: (worktreePath, command) =>
			ipcRenderer.invoke("worktree:run-setup", worktreePath, command),
	},

	// Git helpers
	git: {
		isRepo: (directory) => ipcRenderer.invoke("git:is-repo", directory),
		listBranches: (directory) =>
			ipcRenderer.invoke("git:branch:list", directory),
		currentBranch: (directory) =>
			ipcRenderer.invoke("git:current-branch", directory),
		listWorktrees: (directory) =>
			ipcRenderer.invoke("git:worktree:list", directory),
		addWorktree: (directory, worktreePath, branch, isNewBranch) =>
			ipcRenderer.invoke(
				"git:worktree:add",
				directory,
				worktreePath,
				branch,
				isNewBranch,
			),
		removeWorktree: (directory, worktreePath) =>
			ipcRenderer.invoke("git:worktree:remove", directory, worktreePath),
		merge: (directory, branch) =>
			ipcRenderer.invoke("git:merge", directory, branch),
		mergeAbort: (directory) => ipcRenderer.invoke("git:merge:abort", directory),
		getRemoteUrl: (directory) =>
			ipcRenderer.invoke("git:remote:url", directory),
	},

	// OpenCode bridge
	opencode: {
		// Project management (multi-project)
		addProject: (config) => ipcRenderer.invoke("opencode:project:add", config),
		removeProject: (directory, workspaceId) =>
			ipcRenderer.invoke("opencode:project:remove", directory, workspaceId),
		disconnect: () => ipcRenderer.invoke("opencode:disconnect"),

		// Sessions
		listSessions: (directory, workspaceId) =>
			ipcRenderer.invoke("opencode:session:list", directory, workspaceId),
		createSession: (title, directory, workspaceId) =>
			ipcRenderer.invoke("opencode:session:create", title, directory, workspaceId),
		deleteSession: (id) => ipcRenderer.invoke("opencode:session:delete", id),
		updateSession: (id, title) =>
			ipcRenderer.invoke("opencode:session:update", id, title),
		getSessionStatuses: (directory, workspaceId) =>
			ipcRenderer.invoke("opencode:session:statuses", directory, workspaceId),
		revertSession: (id, messageID, partID) =>
			ipcRenderer.invoke("opencode:session:revert", id, messageID, partID),
		unrevertSession: (id) =>
			ipcRenderer.invoke("opencode:session:unrevert", id),
		forkSession: (id, messageID) =>
			ipcRenderer.invoke("opencode:session:fork", id, messageID),

		// Providers / models
		getProviders: (directory, workspaceId) =>
			ipcRenderer.invoke("opencode:providers", directory, workspaceId),
		// Provider management
		listAllProviders: (directory, workspaceId) =>
			ipcRenderer.invoke("opencode:provider:list", directory, workspaceId),
		getProviderAuthMethods: (directory, workspaceId) =>
			ipcRenderer.invoke("opencode:provider:auth-methods", directory, workspaceId),
		connectProvider: (directory, workspaceId, providerID, auth) =>
			ipcRenderer.invoke(
				"opencode:provider:connect",
				directory,
				workspaceId,
				providerID,
				auth,
			),
		disconnectProvider: (directory, workspaceId, providerID) =>
			ipcRenderer.invoke(
				"opencode:provider:disconnect",
				directory,
				workspaceId,
				providerID,
			),
		oauthAuthorize: (directory, workspaceId, providerID, method) =>
			ipcRenderer.invoke(
				"opencode:provider:oauth:authorize",
				directory,
				workspaceId,
				providerID,
				method,
			),
		oauthCallback: (directory, workspaceId, providerID, method, code) =>
			ipcRenderer.invoke(
				"opencode:provider:oauth:callback",
				directory,
				workspaceId,
				providerID,
				method,
				code,
			),
		disposeInstance: (directory, workspaceId) =>
			ipcRenderer.invoke("opencode:instance:dispose", directory, workspaceId),
		// Agents
		getAgents: (directory, workspaceId) =>
			ipcRenderer.invoke("opencode:agents", directory, workspaceId),

		// Messages
		getMessages: (sessionId, options, directory, workspaceId) =>
			ipcRenderer.invoke(
				"opencode:messages",
				sessionId,
				options,
				directory,
				workspaceId,
			),
		prompt: (sessionId, text, images, model, agent, variant) =>
			ipcRenderer.invoke(
				"opencode:prompt",
				sessionId,
				text,
				images,
				model,
				agent,
				variant,
			),
		abort: (sessionId) => ipcRenderer.invoke("opencode:abort", sessionId),

		// Permissions
		respondPermission: (sessionId, permissionId, response) =>
			ipcRenderer.invoke(
				"opencode:permission",
				sessionId,
				permissionId,
				response,
			),

		// Commands
		getCommands: (directory, workspaceId) =>
			ipcRenderer.invoke("opencode:commands", directory, workspaceId),
		sendCommand: (sessionId, command, args, model, agent, variant) =>
			ipcRenderer.invoke(
				"opencode:command:send",
				sessionId,
				command,
				args,
				model,
				agent,
				variant,
			),

		// Questions
		replyQuestion: (requestID, answers) =>
			ipcRenderer.invoke("opencode:question:reply", requestID, answers),
		rejectQuestion: (requestID) =>
			ipcRenderer.invoke("opencode:question:reject", requestID),

		// MCP
		getMcpStatus: (directory, workspaceId) =>
			ipcRenderer.invoke("opencode:mcp:status", directory, workspaceId),
		addMcp: (directory, workspaceId, name, config) =>
			ipcRenderer.invoke(
				"opencode:mcp:add",
				directory,
				workspaceId,
				name,
				config,
			),
		connectMcp: (directory, workspaceId, name) =>
			ipcRenderer.invoke("opencode:mcp:connect", directory, workspaceId, name),
		disconnectMcp: (directory, workspaceId, name) =>
			ipcRenderer.invoke(
				"opencode:mcp:disconnect",
				directory,
				workspaceId,
				name,
			),

		// Config
		getConfig: (directory, workspaceId) =>
			ipcRenderer.invoke("opencode:config:get", directory, workspaceId),
		updateConfig: (directory, workspaceId, config) =>
			ipcRenderer.invoke(
				"opencode:config:update",
				directory,
				workspaceId,
				config,
			),

		// File search
		findFiles: (directory, workspaceId, query) =>
			ipcRenderer.invoke("opencode:find:files", directory, workspaceId, query),

		// Skills
		getSkills: (directory, workspaceId) =>
			ipcRenderer.invoke("opencode:skills", directory, workspaceId),

		// Local server management
		startServer: () => ipcRenderer.invoke("opencode:server:start"),
		stopServer: () => ipcRenderer.invoke("opencode:server:stop"),
		getServerStatus: () => ipcRenderer.invoke("opencode:server:status"),

		// SSE events from main process
		onEvent: (callback) => {
			const handler = (_event, data) => callback(data);
			ipcRenderer.on("opencode:bridge-event", handler);
			// Return cleanup function
			return () => ipcRenderer.removeListener("opencode:bridge-event", handler);
		},
	},
});
