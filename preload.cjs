const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
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

	// Open a URL in the system browser
	openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),

	// Open a directory in the system file browser
	openInFileBrowser: (dirPath) =>
		ipcRenderer.invoke("shell:openInFileBrowser", dirPath),

	// Open a terminal at a directory
	openInTerminal: (dirPath) =>
		ipcRenderer.invoke("shell:openInTerminal", dirPath),

	// Home directory (for path abbreviation)
	getHomeDir: () => ipcRenderer.invoke("platform:homeDir"),

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
		removeProject: (directory) =>
			ipcRenderer.invoke("opencode:project:remove", directory),
		disconnect: () => ipcRenderer.invoke("opencode:disconnect"),

		// Sessions
		listSessions: (directory) =>
			ipcRenderer.invoke("opencode:session:list", directory),
		createSession: (title, directory) =>
			ipcRenderer.invoke("opencode:session:create", title, directory),
		deleteSession: (id) => ipcRenderer.invoke("opencode:session:delete", id),
		updateSession: (id, title) =>
			ipcRenderer.invoke("opencode:session:update", id, title),
		getSessionStatuses: (directory) =>
			ipcRenderer.invoke("opencode:session:statuses", directory),
		revertSession: (id, messageID, partID) =>
			ipcRenderer.invoke("opencode:session:revert", id, messageID, partID),
		unrevertSession: (id) =>
			ipcRenderer.invoke("opencode:session:unrevert", id),
		forkSession: (id, messageID) =>
			ipcRenderer.invoke("opencode:session:fork", id, messageID),

		// Providers / models
		getProviders: () => ipcRenderer.invoke("opencode:providers"),
		// Provider management
		listAllProviders: () => ipcRenderer.invoke("opencode:provider:list"),
		getProviderAuthMethods: () =>
			ipcRenderer.invoke("opencode:provider:auth-methods"),
		connectProvider: (providerID, auth) =>
			ipcRenderer.invoke("opencode:provider:connect", providerID, auth),
		disconnectProvider: (providerID) =>
			ipcRenderer.invoke("opencode:provider:disconnect", providerID),
		oauthAuthorize: (providerID, method) =>
			ipcRenderer.invoke(
				"opencode:provider:oauth:authorize",
				providerID,
				method,
			),
		oauthCallback: (providerID, method, code) =>
			ipcRenderer.invoke(
				"opencode:provider:oauth:callback",
				providerID,
				method,
				code,
			),
		disposeInstance: () => ipcRenderer.invoke("opencode:instance:dispose"),
		// Agents
		getAgents: () => ipcRenderer.invoke("opencode:agents"),

		// Messages
		getMessages: (sessionId) =>
			ipcRenderer.invoke("opencode:messages", sessionId),
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
		getCommands: () => ipcRenderer.invoke("opencode:commands"),
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
		getMcpStatus: () => ipcRenderer.invoke("opencode:mcp:status"),
		addMcp: (name, config) =>
			ipcRenderer.invoke("opencode:mcp:add", name, config),
		connectMcp: (name) => ipcRenderer.invoke("opencode:mcp:connect", name),
		disconnectMcp: (name) =>
			ipcRenderer.invoke("opencode:mcp:disconnect", name),

		// Config
		getConfig: () => ipcRenderer.invoke("opencode:config:get"),
		updateConfig: (config) =>
			ipcRenderer.invoke("opencode:config:update", config),

		// Skills
		getSkills: () => ipcRenderer.invoke("opencode:skills"),

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
