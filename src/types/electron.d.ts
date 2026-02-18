import type {
	Event as OpenCodeEvent,
	Session,
	Message,
	Part,
	Provider,
	Agent,
	Command,
	QuestionAnswer,
	McpLocalConfig,
	McpRemoteConfig,
	McpStatus,
	Config as OpenCodeConfig,
} from "@opencode-ai/sdk/v2/client";

// ---------------------------------------------------------------------------
// Provider management types
// ---------------------------------------------------------------------------

export interface ProviderAuthMethod {
	type: "oauth" | "api";
	label: string;
}

export interface ProviderOAuthAuthorization {
	url: string;
	method: "auto" | "code";
	instructions: string;
}

export type ProviderAuth =
	| { type: "api"; key: string }
	| {
			type: "oauth";
			refresh: string;
			access: string;
			expires: number;
			accountId?: string;
			enterpriseUrl?: string;
	  }
	| { type: "wellknown"; key: string; token: string };

export interface AllProvidersData {
	all: Provider[];
	default: { [key: string]: string };
	connected: string[];
}

// ---------------------------------------------------------------------------
// Connection types mirrored from opencode-bridge
// ---------------------------------------------------------------------------

export type ConnectionState =
	| "idle"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "error";

export interface ConnectionStatus {
	state: ConnectionState;
	serverUrl: string | null;
	serverVersion: string | null;
	error: string | null;
	lastEventAt: number | null;
}

export interface ConnectionConfig {
	baseUrl: string;
	username?: string;
	password?: string;
	directory?: string;
}

/** Bridge events are tagged with the directory they originate from. */
export type BridgeEvent =
	| {
			type: "connection:status";
			payload: ConnectionStatus;
			directory: string;
	  }
	| { type: "opencode:event"; payload: OpenCodeEvent; directory: string };

/** Standard IPC result envelope */
export interface IPCResult<T = unknown> {
	success: boolean;
	data?: T;
	error?: string;
	status?: ConnectionStatus;
}

// ---------------------------------------------------------------------------
// Bridge API exposed via preload
// ---------------------------------------------------------------------------

export interface SelectedModel {
	providerID: string;
	modelID: string;
}

export interface ProvidersData {
	providers: Provider[];
	default: { [key: string]: string };
}

export interface OpenCodeBridge {
	/** Start the local opencode server on port 4096 (detached, survives app close). */
	startServer(): Promise<IPCResult<{ alreadyRunning?: boolean }>>;
	/** Check whether the local opencode server is running. */
	getServerStatus(): Promise<IPCResult<{ running: boolean }>>;

	/** Connect a project directory (additive - does not tear down other projects). */
	addProject(config: ConnectionConfig): Promise<IPCResult>;
	/** Disconnect a specific project by directory. */
	removeProject(directory: string): Promise<IPCResult>;
	/** Disconnect ALL projects. */
	disconnect(): Promise<IPCResult>;

	listSessions(directory?: string): Promise<IPCResult<Session[]>>;
	createSession(
		title?: string,
		directory?: string,
	): Promise<IPCResult<Session>>;
	deleteSession(id: string): Promise<IPCResult<boolean>>;
	getSessionStatuses(
		directory?: string,
	): Promise<IPCResult<Record<string, { type: string }>>>;
	/** Revert a session to a specific message, undoing changes after that point. */
	revertSession(
		id: string,
		messageID: string,
		partID?: string,
	): Promise<IPCResult<Session>>;
	/** Restore all previously reverted messages in a session. */
	unrevertSession(id: string): Promise<IPCResult<Session>>;
	/** Fork a session at a specific message, creating a new session with messages up to that point. */
	forkSession(id: string, messageID?: string): Promise<IPCResult<Session>>;

	getProviders(): Promise<IPCResult<ProvidersData>>;

	/** List ALL providers (connected + disconnected) with connection status. */
	listAllProviders(): Promise<IPCResult<AllProvidersData>>;
	/** Get available auth methods per provider. */
	getProviderAuthMethods(): Promise<
		IPCResult<Record<string, ProviderAuthMethod[]>>
	>;
	/** Set auth credentials (API key or OAuth tokens) for a provider. */
	connectProvider(providerID: string, auth: ProviderAuth): Promise<IPCResult>;
	/** Remove auth credentials for a provider (disconnect it). */
	disconnectProvider(providerID: string): Promise<IPCResult>;
	/** Start an OAuth authorization flow for a provider. */
	oauthAuthorize(
		providerID: string,
		method?: number,
	): Promise<IPCResult<ProviderOAuthAuthorization>>;
	/** Complete an OAuth flow with an authorization code. */
	oauthCallback(
		providerID: string,
		method?: number,
		code?: string,
	): Promise<IPCResult<boolean>>;
	/** Dispose the current instance to force a refresh. */
	disposeInstance(): Promise<IPCResult<boolean>>;

	getAgents(): Promise<IPCResult<Agent[]>>;
	getCommands(): Promise<IPCResult<Command[]>>;
	sendCommand(
		sessionId: string,
		command: string,
		args: string,
		model?: SelectedModel,
		agent?: string,
		variant?: string,
	): Promise<IPCResult>;

	getMessages(
		sessionId: string,
	): Promise<IPCResult<Array<{ info: Message; parts: Part[] }>>>;
	prompt(
		sessionId: string,
		text: string,
		images?: string[],
		model?: SelectedModel,
		agent?: string,
		variant?: string,
	): Promise<IPCResult>;
	abort(sessionId: string): Promise<IPCResult>;

	respondPermission(
		sessionId: string,
		permissionId: string,
		response: "once" | "always" | "reject",
	): Promise<IPCResult>;

	replyQuestion(
		requestID: string,
		answers: QuestionAnswer[],
	): Promise<IPCResult>;
	rejectQuestion(requestID: string): Promise<IPCResult>;

	// MCP
	getMcpStatus(): Promise<IPCResult<Record<string, McpStatus>>>;
	addMcp(
		name: string,
		config: McpLocalConfig | McpRemoteConfig,
	): Promise<IPCResult<Record<string, McpStatus>>>;
	connectMcp(name: string): Promise<IPCResult>;
	disconnectMcp(name: string): Promise<IPCResult>;

	// Config
	getConfig(): Promise<IPCResult<OpenCodeConfig>>;
	updateConfig(
		config: Partial<OpenCodeConfig>,
	): Promise<IPCResult<OpenCodeConfig>>;

	// Skills
	getSkills(): Promise<
		IPCResult<
			Array<{
				name: string;
				description: string;
				location: string;
				content: string;
			}>
		>
	>;

	/** Subscribe to bridge events (SSE + connection status). Returns unsubscribe fn. */
	onEvent(callback: (event: BridgeEvent) => void): () => void;
}

// ---------------------------------------------------------------------------
// Window API
// ---------------------------------------------------------------------------

export interface ElectronAPI {
	minimize: () => Promise<void>;
	maximize: () => Promise<void>;
	close: () => Promise<void>;
	isMaximized: () => Promise<boolean>;
	getPlatform: () => Promise<string>;
	onMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void;

	/** Open a native directory picker dialog. Returns the selected path or null. */
	openDirectory: () => Promise<string | null>;

	/** Open a URL in the system browser (not in Electron). */
	openExternal: (url: string) => Promise<void>;

	/** Get the user's home directory path. */
	getHomeDir: () => Promise<string>;

	opencode: OpenCodeBridge;
}

declare global {
	interface Window {
		electronAPI?: ElectronAPI;
	}
}
