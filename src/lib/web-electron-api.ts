import type { ElectronAPI } from "@/types/electron";

type Listener = (data: unknown) => void;

const SETTINGS_PREFIX = "opengui:web:settings:";
const listeners = new Map<string, Set<Listener>>();

function emit(channel: string, data: unknown) {
	for (const listener of listeners.get(channel) ?? []) listener(data);
}

function on(channel: string, callback: Listener) {
	let set = listeners.get(channel);
	if (!set) {
		set = new Set();
		listeners.set(channel, set);
	}
	set.add(callback);
	return () => set?.delete(callback);
}

async function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
	const response = await fetch("/api/rpc", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ channel, args }),
	});
	const body = await response.json().catch(() => null);
	if (!response.ok || !body?.ok) {
		throw new Error(body?.error || `RPC failed: ${channel}`);
	}
	return body.value as T;
}

function settingKey(key: string) {
	return `${SETTINGS_PREFIX}${key}`;
}

function settingsGetSync(key: string) {
	return localStorage.getItem(settingKey(key));
}

function settingsSetSync(key: string, value: string) {
	localStorage.setItem(settingKey(key), value);
	void invoke("settings:set", key, value).catch(console.error);
	emit("settings:changed", { key, value });
	return true;
}

function settingsRemoveSync(key: string) {
	localStorage.removeItem(settingKey(key));
	void invoke("settings:remove", key).catch(console.error);
	emit("settings:changed", { key, value: null });
	return true;
}

function getAllSettingsSync() {
	const result: Record<string, string> = {};
	for (let i = 0; i < localStorage.length; i++) {
		const key = localStorage.key(i);
		if (!key?.startsWith(SETTINGS_PREFIX)) continue;
		const value = localStorage.getItem(key);
		if (value != null) result[key.slice(SETTINGS_PREFIX.length)] = value;
	}
	return result;
}

function mergeSettingsSync(entries: Record<string, string>) {
	for (const [key, value] of Object.entries(entries)) settingsSetSync(key, value);
	void invoke("settings:merge", entries).catch(console.error);
	return true;
}

function subscribeEvents() {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	let closed = false;
	let retry: number | undefined;

	const connect = () => {
		const ws = new WebSocket(`${protocol}//${location.host}/api/events`);
		ws.onmessage = (event) => {
			try {
				const message = JSON.parse(event.data);
				if (message?.channel) emit(message.channel, message.data);
			} catch (error) {
				console.error("Bad web event", error);
			}
		};
		ws.onclose = () => {
			if (closed) return;
			retry = window.setTimeout(connect, 1000);
		};
	};

	connect();
	return () => {
		closed = true;
		if (retry) window.clearTimeout(retry);
	};
}

function baseAgent(prefix: "claude-code" | "pi" | "codex") {
	return {
		addProject: (config: unknown) => invoke(`${prefix}:project:add`, config),
		removeProject: (directory: string, workspaceId?: string) => invoke(`${prefix}:project:remove`, directory, workspaceId),
		disconnect: () => invoke(`${prefix}:disconnect`),
		listSessions: (directory?: string, workspaceId?: string) => invoke(`${prefix}:session:list`, directory, workspaceId),
		createSession: (title?: string, directory?: string, workspaceId?: string) => invoke(`${prefix}:session:create`, title, directory, workspaceId),
		deleteSession: (sessionId: string, directory?: string, workspaceId?: string) => invoke(`${prefix}:session:delete`, sessionId, directory, workspaceId),
		updateSession: (sessionId: string, title: string, directory?: string, workspaceId?: string) => invoke(`${prefix}:session:update`, sessionId, title, directory, workspaceId),
		getSessionStatuses: (directory?: string, workspaceId?: string) => invoke(`${prefix}:session:statuses`, directory, workspaceId),
		forkSession: (sessionId: string, messageID?: string, directory?: string, workspaceId?: string) => invoke(`${prefix}:session:fork`, sessionId, messageID, directory, workspaceId),
		getProviders: (directory?: string, workspaceId?: string) => invoke(`${prefix}:providers`, directory, workspaceId),
		getAgents: (directory?: string, workspaceId?: string) => invoke(`${prefix}:agents`, directory, workspaceId),
		getCommands: (directory?: string, workspaceId?: string) => invoke(`${prefix}:commands`, directory, workspaceId),
		getMessages: (sessionId: string, options?: unknown, directory?: string, workspaceId?: string) => invoke(`${prefix}:messages`, sessionId, options, directory, workspaceId),
		startSession: (input: unknown) => invoke(`${prefix}:session:start`, input),
		prompt: (sessionId: string, text: string, images: unknown, model: unknown, agent: unknown, variant: unknown, directory?: string, workspaceId?: string) => invoke(`${prefix}:prompt`, sessionId, text, images, model, agent, variant, directory, workspaceId),
		abort: (sessionId: string) => invoke(`${prefix}:abort`, sessionId),
		respondPermission: (sessionId: string, permissionId: string, response: unknown) => invoke(`${prefix}:permission`, sessionId, permissionId, response),
		sendCommand: (sessionId: string, command: string, args: unknown, model: unknown, agent: unknown, variant: unknown, directory?: string, workspaceId?: string) => invoke(`${prefix}:command:send`, sessionId, command, args, model, agent, variant, directory, workspaceId),
		summarizeSession: (sessionId: string, model: unknown, directory?: string, workspaceId?: string) => invoke(`${prefix}:session:summarize`, sessionId, model, directory, workspaceId),
		findFiles: (directory?: string, workspaceId?: string, query?: string) => invoke(`${prefix}:find:files`, directory, workspaceId, query),
		onEvent: (callback: Listener) => on(`${prefix}:bridge-event`, callback),
	};
}

export function installWebElectronAPI() {
	if (window.electronAPI) return;
	subscribeEvents();

	window.electronAPI = {
		settings: {
			getAllSync: getAllSettingsSync,
			getSync: settingsGetSync,
			setSync: settingsSetSync,
			removeSync: settingsRemoveSync,
			mergeSync: mergeSettingsSync,
			set: async (key: string, value: string) => settingsSetSync(key, value),
			remove: async (key: string) => settingsRemoveSync(key),
			onDidChange: (callback: (change: unknown) => void) => on("settings:changed", callback),
		},
		minimize: () => invoke("window:minimize"),
		maximize: () => invoke("window:maximize"),
		close: () => invoke("window:close"),
		isMaximized: () => invoke("window:isMaximized"),
		getPlatform: () => invoke("platform:get"),
		onMaximizeChange: () => () => {},
		openDirectory: () => invoke("dialog:openDirectory"),
		detachProject: (projectDir: string) => invoke("window:detachProject", projectDir),
		getDetachedProject: () => new URLSearchParams(window.location.search).get("detach"),
		getDetachedProjects: () => invoke("window:getDetachedProjects"),
		onDetachedProjectsChange: () => () => {},
		openExternal: (url: string) => invoke("shell:openExternal", url),
		updates: {
			getState: async () => ({ status: "idle" }),
			check: async () => undefined,
			download: async () => undefined,
			install: async () => undefined,
			onStateChanged: () => () => {},
		},
		openInFileBrowser: (dirPath: string, command = "") => invoke("shell:openInFileBrowser", dirPath, command),
		openInTerminal: (dirPath: string, command = "") => invoke("shell:openInTerminal", dirPath, command),
		getHomeDir: () => invoke("platform:homeDir"),
		worktree: {
			detectSetup: (worktreePath: string) => invoke("worktree:detect-setup", worktreePath),
			runSetup: (worktreePath: string, command: string) => invoke("worktree:run-setup", worktreePath, command),
		},
		git: {
			isRepo: (directory: string) => invoke("git:is-repo", directory),
			listBranches: (directory: string) => invoke("git:branch:list", directory),
			currentBranch: (directory: string) => invoke("git:current-branch", directory),
			listWorktrees: (directory: string) => invoke("git:worktree:list", directory),
			addWorktree: (directory: string, worktreePath: string, branch: string, isNewBranch: boolean) => invoke("git:worktree:add", directory, worktreePath, branch, isNewBranch),
			removeWorktree: (directory: string, worktreePath: string) => invoke("git:worktree:remove", directory, worktreePath),
			merge: (directory: string, branch: string) => invoke("git:merge", directory, branch),
			mergeAbort: (directory: string) => invoke("git:merge:abort", directory),
			getRemoteUrl: (directory: string) => invoke("git:remote:url", directory),
		},
		claudeCode: baseAgent("claude-code"),
		pi: baseAgent("pi"),
		codex: baseAgent("codex"),
		opencode: {
			addProject: (config: unknown) => invoke("opencode:project:add", config),
			removeProject: (directory: string, workspaceId?: string) => invoke("opencode:project:remove", directory, workspaceId),
			disconnect: () => invoke("opencode:disconnect"),
			listSessions: (directory?: string, workspaceId?: string) => invoke("opencode:session:list", directory, workspaceId),
			createSession: (title?: string, directory?: string, workspaceId?: string) => invoke("opencode:session:create", title, directory, workspaceId),
			deleteSession: (id: string) => invoke("opencode:session:delete", id),
			updateSession: (id: string, title: string) => invoke("opencode:session:update", id, title),
			getSessionStatuses: (directory?: string, workspaceId?: string) => invoke("opencode:session:statuses", directory, workspaceId),
			revertSession: (id: string, messageID: string, partID?: string) => invoke("opencode:session:revert", id, messageID, partID),
			unrevertSession: (id: string) => invoke("opencode:session:unrevert", id),
			forkSession: (id: string, messageID?: string) => invoke("opencode:session:fork", id, messageID),
			getProviders: (directory?: string, workspaceId?: string) => invoke("opencode:providers", directory, workspaceId),
			listAllProviders: (directory?: string, workspaceId?: string) => invoke("opencode:provider:list", directory, workspaceId),
			getProviderAuthMethods: (directory?: string, workspaceId?: string) => invoke("opencode:provider:auth-methods", directory, workspaceId),
			connectProvider: (directory: string | undefined, workspaceId: string | undefined, providerID: string, auth: unknown) => invoke("opencode:provider:connect", directory, workspaceId, providerID, auth),
			disconnectProvider: (directory: string | undefined, workspaceId: string | undefined, providerID: string) => invoke("opencode:provider:disconnect", directory, workspaceId, providerID),
			oauthAuthorize: (directory: string | undefined, workspaceId: string | undefined, providerID: string, method: unknown) => invoke("opencode:provider:oauth:authorize", directory, workspaceId, providerID, method),
			oauthCallback: (directory: string | undefined, workspaceId: string | undefined, providerID: string, method: unknown, code: string) => invoke("opencode:provider:oauth:callback", directory, workspaceId, providerID, method, code),
			disposeInstance: (directory?: string, workspaceId?: string) => invoke("opencode:instance:dispose", directory, workspaceId),
			getAgents: (directory?: string, workspaceId?: string) => invoke("opencode:agents", directory, workspaceId),
			getMessages: (sessionId: string, options?: unknown, directory?: string, workspaceId?: string) => invoke("opencode:messages", sessionId, options, directory, workspaceId),
			prompt: (sessionId: string, text: string, images: unknown, model: unknown, agent: unknown, variant: unknown) => invoke("opencode:prompt", sessionId, text, images, model, agent, variant),
			abort: (sessionId: string) => invoke("opencode:abort", sessionId),
			respondPermission: (sessionId: string, permissionId: string, response: unknown) => invoke("opencode:permission", sessionId, permissionId, response),
			getCommands: (directory?: string, workspaceId?: string) => invoke("opencode:commands", directory, workspaceId),
			sendCommand: (sessionId: string, command: string, args: unknown, model: unknown, agent: unknown, variant: unknown) => invoke("opencode:command:send", sessionId, command, args, model, agent, variant),
			summarizeSession: (sessionId: string, model: unknown) => invoke("opencode:session:summarize", sessionId, model),
			replyQuestion: (requestID: string, answers: unknown) => invoke("opencode:question:reply", requestID, answers),
			rejectQuestion: (requestID: string) => invoke("opencode:question:reject", requestID),
			getMcpStatus: (directory?: string, workspaceId?: string) => invoke("opencode:mcp:status", directory, workspaceId),
			addMcp: (directory: string | undefined, workspaceId: string | undefined, name: string, config: unknown) => invoke("opencode:mcp:add", directory, workspaceId, name, config),
			connectMcp: (directory: string | undefined, workspaceId: string | undefined, name: string) => invoke("opencode:mcp:connect", directory, workspaceId, name),
			disconnectMcp: (directory: string | undefined, workspaceId: string | undefined, name: string) => invoke("opencode:mcp:disconnect", directory, workspaceId, name),
			getConfig: (directory?: string, workspaceId?: string) => invoke("opencode:config:get", directory, workspaceId),
			updateConfig: (directory: string | undefined, workspaceId: string | undefined, config: unknown) => invoke("opencode:config:update", directory, workspaceId, config),
			findFiles: (directory?: string, workspaceId?: string, query?: string) => invoke("opencode:find:files", directory, workspaceId, query),
			getSkills: (directory?: string, workspaceId?: string) => invoke("opencode:skills", directory, workspaceId),
			startServer: () => invoke("opencode:server:start"),
			stopServer: () => invoke("opencode:server:stop"),
			getServerStatus: () => invoke("opencode:server:status"),
			onEvent: (callback: Listener) => on("opencode:bridge-event", callback),
		},
	} as unknown as ElectronAPI;
}
