import type {
	Agent,
	Command,
	Message,
	McpLocalConfig,
	McpRemoteConfig,
	McpStatus,
	Part,
	PermissionRequest,
	Provider,
	QuestionAnswer,
	QuestionRequest,
	Session,
	Config as OpenCodeConfig,
} from "@opencode-ai/sdk/v2/client";
import type {
	AllProvidersData,
	ConnectionConfig,
	ConnectionStatus,
	ProviderAuth,
	ProviderAuthMethod,
	ProviderOAuthAuthorization,
	SelectedModel,
} from "@/types/electron";

export interface AgentBackendTarget {
	directory?: string;
	workspaceId?: string;
}

export interface AgentBackendCapabilities {
	sessions: boolean;
	streaming: boolean;
	messagePaging: boolean;
	images: boolean;
	models: boolean;
	agents: boolean;
	commands: boolean;
	compact: boolean;
	fork: boolean;
	revert: boolean;
	permissions: boolean;
	questions: boolean;
	providerAuth: boolean;
	mcp: boolean;
	skills: boolean;
	config: boolean;
	localServer: boolean;
}

export interface AgentBackendWorkspaceProfile {
	kind: "remote-server" | "local-cli";
	fields: {
		serverUrl: boolean;
		username: boolean;
		password: boolean;
		directory: boolean;
	};
}

export interface AgentSessionStatus {
	type: string;
}

export interface AgentMessagePage {
	messages: Array<{ info: Message; parts: Part[] }>;
	nextCursor: string | null;
}

export type AgentBackendEvent =
	| {
			type: "connection.status";
			directory: string;
			workspaceId?: string;
			status: ConnectionStatus;
	  }
	| {
			type: "session.created" | "session.updated";
			directory: string;
			workspaceId?: string;
			session: Session;
	  }
	| {
			type: "session.deleted";
			directory: string;
			workspaceId?: string;
			sessionId: string;
	  }
	| { type: "message.updated"; message: Message }
	| { type: "message.part.updated"; part: Part }
	| {
			type: "message.part.delta";
			sessionID: string;
			messageID: string;
			partID: string;
			field: string;
			delta: string;
	  }
	| {
			type: "message.part.removed";
			sessionID: string;
			messageID: string;
			partID: string;
	  }
	| { type: "message.removed"; sessionID: string; messageID: string }
	| { type: "session.status"; sessionID: string; status: AgentSessionStatus }
	| { type: "permission.requested"; request: PermissionRequest }
	| { type: "permission.cleared"; sessionID: string }
	| { type: "question.requested"; request: QuestionRequest }
	| { type: "question.cleared"; sessionID: string }
	| { type: "session.error"; error: string; sessionID?: string };

export interface AgentRuntimeBackend {
	listSessions(target?: AgentBackendTarget): Promise<Session[]>;
	createSession(input?: {
		title?: string;
		directory?: string;
		workspaceId?: string;
	}): Promise<Session>;
	startSession?(input: {
		text: string;
		images?: string[];
		model?: SelectedModel;
		agent?: string;
		variant?: string;
		title?: string;
		directory?: string;
		workspaceId?: string;
	}): Promise<Session>;
	deleteSession(sessionId: string): Promise<boolean>;
	renameSession(sessionId: string, title: string): Promise<Session>;
	listSessionStatuses(
		target?: AgentBackendTarget,
	): Promise<Record<string, AgentSessionStatus>>;
	getMessages(
		sessionId: string,
		options?: { limit?: number; before?: string } & AgentBackendTarget,
	): Promise<AgentMessagePage>;
	prompt(input: {
		sessionId: string;
		text: string;
		images?: string[];
		model?: SelectedModel;
		agent?: string;
		variant?: string;
	}): Promise<void>;
	abort(sessionId: string): Promise<void>;
	compactSession(sessionId: string, model?: SelectedModel): Promise<void>;
	forkSession(sessionId: string, messageID?: string): Promise<Session>;
	revertSession(
		sessionId: string,
		messageID: string,
		partID?: string,
	): Promise<Session>;
	unrevertSession(sessionId: string): Promise<Session>;
	listProviders(target?: AgentBackendTarget): Promise<{
		providers: Provider[];
		default: Record<string, string>;
	}>;
	listAgents(target?: AgentBackendTarget): Promise<Agent[]>;
	listCommands(target?: AgentBackendTarget): Promise<Command[]>;
	sendCommand(input: {
		sessionId: string;
		command: string;
		args: string;
		model?: SelectedModel;
		agent?: string;
		variant?: string;
	}): Promise<void>;
	respondPermission(
		sessionId: string,
		permissionId: string,
		response: "once" | "always" | "reject",
	): Promise<void>;
	replyQuestion(requestID: string, answers: QuestionAnswer[]): Promise<void>;
	rejectQuestion(requestID: string): Promise<void>;
	findFiles(target: AgentBackendTarget, query: string): Promise<string[]>;
	subscribe(listener: (event: AgentBackendEvent) => void): () => void;
}

export interface AgentHostBackend {
	addProject(config: ConnectionConfig): Promise<void>;
	removeProject(target: AgentBackendTarget): Promise<void>;
	disconnect(): Promise<void>;
}

export interface AgentPlatformBackend {
	server?: {
		start(): Promise<{ alreadyRunning?: boolean }>;
		stop(): Promise<{ alreadyStopped?: boolean; pid?: number }>;
		status(): Promise<{ running: boolean }>;
	};
	providers?: {
		listAll(target?: AgentBackendTarget): Promise<AllProvidersData>;
		getAuthMethods(
			target?: AgentBackendTarget,
		): Promise<Record<string, ProviderAuthMethod[]>>;
		connect(
			target: AgentBackendTarget,
			providerID: string,
			auth: ProviderAuth,
		): Promise<void>;
		disconnect(target: AgentBackendTarget, providerID: string): Promise<void>;
		oauthAuthorize(
			target: AgentBackendTarget,
			providerID: string,
			method?: number,
		): Promise<ProviderOAuthAuthorization>;
		oauthCallback(
			target: AgentBackendTarget,
			providerID: string,
			method?: number,
			code?: string,
		): Promise<boolean>;
		dispose(target?: AgentBackendTarget): Promise<boolean>;
	};
	mcp?: {
		status(target?: AgentBackendTarget): Promise<Record<string, McpStatus>>;
		add(
			target: AgentBackendTarget,
			name: string,
			config: McpLocalConfig | McpRemoteConfig,
		): Promise<Record<string, McpStatus>>;
		connect(target: AgentBackendTarget, name: string): Promise<void>;
		disconnect(target: AgentBackendTarget, name: string): Promise<void>;
	};
	skills?: {
		list(target?: AgentBackendTarget): Promise<
			Array<{
				name: string;
				description: string;
				location: string;
				content: string;
			}>
		>;
	};
	config?: {
		get(target?: AgentBackendTarget): Promise<OpenCodeConfig>;
		update(
			target: AgentBackendTarget,
			config: Partial<OpenCodeConfig>,
		): Promise<OpenCodeConfig>;
	};
}

export interface AgentBackendDescriptor {
	id: string;
	label: string;
	workspace: AgentBackendWorkspaceProfile;
	capabilities: AgentBackendCapabilities;
	host: AgentHostBackend;
	runtime: AgentRuntimeBackend;
	platform?: AgentPlatformBackend;
}
