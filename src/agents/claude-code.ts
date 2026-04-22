import type { Session } from "@opencode-ai/sdk/v2/client";
import type { NativeBackendEvent, SelectedModel } from "@/types/electron";
import type {
	AgentBackendCapabilities,
	AgentBackendDescriptor,
	AgentBackendEvent,
	AgentBackendTarget,
} from "./backend";

interface ClaudeCodeBridge {
	addProject(config: {
		workspaceId?: string;
		baseUrl: string;
		username?: string;
		password?: string;
		directory?: string;
	}): Promise<{ success: boolean; error?: string }>;
	removeProject(
		directory: string,
		workspaceId?: string,
	): Promise<{ success: boolean; error?: string }>;
	disconnect(): Promise<{ success: boolean; error?: string }>;
	listSessions(
		directory?: string,
		workspaceId?: string,
	): Promise<{ success: boolean; data?: any; error?: string }>;
	deleteSession(
		sessionId: string,
		directory?: string,
		workspaceId?: string,
	): Promise<{ success: boolean; data?: boolean; error?: string }>;
	updateSession(
		sessionId: string,
		title: string,
		directory?: string,
		workspaceId?: string,
	): Promise<{ success: boolean; data?: any; error?: string }>;
	getSessionStatuses(
		directory?: string,
		workspaceId?: string,
	): Promise<{ success: boolean; data?: Record<string, { type: string }>; error?: string }>;
	forkSession(
		sessionId: string,
		messageID?: string,
		directory?: string,
		workspaceId?: string,
	): Promise<{ success: boolean; data?: any; error?: string }>;
	getProviders(
		directory?: string,
		workspaceId?: string,
	): Promise<{ success: boolean; data?: any; error?: string }>;
	getAgents(
		directory?: string,
		workspaceId?: string,
	): Promise<{ success: boolean; data?: any; error?: string }>;
	getCommands(
		directory?: string,
		workspaceId?: string,
	): Promise<{ success: boolean; data?: any; error?: string }>;
	getMessages(
		sessionId: string,
		options?: { limit?: number; before?: string },
		directory?: string,
		workspaceId?: string,
	): Promise<{ success: boolean; data?: any; error?: string }>;
	startSession(input: {
		text: string;
		images?: string[];
		model?: SelectedModel;
		agent?: string;
		variant?: string;
		title?: string;
		directory?: string;
		workspaceId?: string;
	}): Promise<{ success: boolean; data?: any; error?: string }>;
	prompt(
		sessionId: string,
		text: string,
		images?: string[],
		model?: SelectedModel,
		agent?: string,
		variant?: string,
		directory?: string,
		workspaceId?: string,
	): Promise<{ success: boolean; error?: string }>;
	abort(sessionId: string): Promise<{ success: boolean; error?: string }>;
	respondPermission(
		sessionId: string,
		permissionId: string,
		response: "once" | "always" | "reject",
	): Promise<{ success: boolean; error?: string }>;
	sendCommand(
		sessionId: string,
		command: string,
		args: string,
		model?: SelectedModel,
		agent?: string,
		variant?: string,
		directory?: string,
		workspaceId?: string,
	): Promise<{ success: boolean; error?: string }>;
	summarizeSession(
		sessionId: string,
		model?: SelectedModel,
		directory?: string,
		workspaceId?: string,
	): Promise<{ success: boolean; error?: string }>;
	findFiles(
		directory: string | null,
		workspaceId: string | undefined,
		query: string,
	): Promise<{ success: boolean; data?: string[]; error?: string }>;
	onEvent(callback: (event: { type: string; payload?: unknown }) => void): () => void;
}

export interface ClaudeCodeBackendAdapter
	extends ClaudeCodeBridge,
		AgentBackendDescriptor {
	native: ClaudeCodeBridge;
}

const CLAUDE_CODE_CAPABILITIES: AgentBackendCapabilities = {
	sessions: true,
	streaming: true,
	messagePaging: true,
	images: false,
	models: true,
	agents: false,
	commands: true,
	compact: true,
	fork: true,
	revert: false,
	permissions: true,
	questions: false,
	providerAuth: false,
	mcp: false,
	skills: false,
	config: false,
	localServer: false,
};

const CLAUDE_CODE_WORKSPACE = {
	kind: "local-cli",
	fields: {
		serverUrl: false,
		username: false,
		password: false,
		directory: true,
	},
} as const;

function requireSuccess<T>(
	result:
		| { success: true; data?: T }
		| { success: false; error?: string }
		| { success: boolean; data?: T; error?: string },
	fallback: string,
): T {
	if (result.success) return result.data as T;
	throw new Error(result.error ?? fallback);
}

function getTarget(target?: AgentBackendTarget) {
	return {
		directory: target?.directory,
		workspaceId: target?.workspaceId,
	};
}

function tagClaudeSession(
	session: Session,
	target?: { directory?: string; workspaceId?: string },
): Session {
	return {
		...session,
		_projectDir: target?.directory ?? session._projectDir ?? session.directory,
		_workspaceId:
			target?.workspaceId ??
			session._workspaceId ??
			("workspaceID" in session && typeof session.workspaceID === "string"
				? session.workspaceID
				: undefined),
	};
}

function normalizeClaudeCodeEvent(
	event: NativeBackendEvent | { type: string; payload?: unknown },
): AgentBackendEvent | null {
	if (event.type === "connection:status") {
		return {
			type: "connection.status",
			directory: event.directory,
			workspaceId: event.workspaceId,
			status: event.payload,
		};
	}
	if (event.type !== "claude-code:event") return null;
	const payload = (event.payload ?? null) as AgentBackendEvent | null;
	if (!payload) return null;
	switch (payload.type) {
		case "session.created":
			return {
				...payload,
				session: tagClaudeSession(payload.session, {
					directory: payload.directory,
					workspaceId: payload.workspaceId,
				}),
			};
		case "session.updated":
			return {
				...payload,
				session: tagClaudeSession(payload.session, {
					directory: payload.directory,
					workspaceId: payload.workspaceId,
				}),
			};
		default:
			return payload;
	}
}

export function createClaudeCodeBackend(
	bridge?: ClaudeCodeBridge,
): ClaudeCodeBackendAdapter | undefined {
	if (!bridge) return undefined;

	return {
		...bridge,
		id: "claude-code",
		label: "Claude Code",
		workspace: CLAUDE_CODE_WORKSPACE,
		capabilities: CLAUDE_CODE_CAPABILITIES,
		native: bridge,
		host: {
			addProject: async (config) => {
				requireSuccess(await bridge.addProject(config), "Failed to add project");
			},
			removeProject: async (target) => {
				requireSuccess(
					await bridge.removeProject(target.directory ?? "", target.workspaceId),
					"Failed to remove project",
				);
			},
			disconnect: async () => {
				requireSuccess(await bridge.disconnect(), "Failed to disconnect");
			},
		},
		runtime: {
			listSessions: async (target) => {
				const { directory, workspaceId } = getTarget(target);
				const sessions = requireSuccess(
					await bridge.listSessions(directory, workspaceId),
					"Failed to list sessions",
				);
				return sessions.map((session) =>
					tagClaudeSession(session, {
						directory: session.directory ?? directory,
						workspaceId:
							("workspaceID" in session && typeof session.workspaceID === "string"
								? session.workspaceID
								: workspaceId),
					}),
				);
			},
			createSession: async () => {
				throw new Error("Claude Code sessions start with first prompt");
			},
			startSession: async (input) => {
				const session = requireSuccess(
					await bridge.startSession(input),
					"Failed to start session",
				);
				return tagClaudeSession(session, {
					directory: input.directory ?? session.directory,
					workspaceId: input.workspaceId,
				});
			},
			deleteSession: async (sessionId) => {
				const target = getTarget();
				return requireSuccess(
					await bridge.deleteSession(sessionId, target.directory, target.workspaceId),
					"Failed to delete session",
				);
			},
			renameSession: async (sessionId, title) => {
				const target = getTarget();
				const session = requireSuccess(
					await bridge.updateSession(sessionId, title, target.directory, target.workspaceId),
					"Failed to rename session",
				);
				return tagClaudeSession(session, target);
			},
			listSessionStatuses: async (target) => {
				const { directory, workspaceId } = getTarget(target);
				return requireSuccess(
					await bridge.getSessionStatuses(directory, workspaceId),
					"Failed to list session statuses",
				);
			},
			getMessages: async (sessionId, options) => {
				const { directory, workspaceId } = getTarget(options);
				return requireSuccess(
					await bridge.getMessages(sessionId, options, directory, workspaceId),
					"Failed to get messages",
				);
			},
			prompt: async ({ sessionId, text, images, model, agent, variant }) => {
				requireSuccess(
					await bridge.prompt(
						sessionId,
						text,
						images,
						model,
						agent,
						variant,
					),
					"Failed to send prompt",
				);
			},
			abort: async (sessionId) => {
				requireSuccess(await bridge.abort(sessionId), "Failed to abort session");
			},
			compactSession: async (sessionId, model) => {
				requireSuccess(
					await bridge.summarizeSession(sessionId, model),
					"Failed to compact session",
				);
			},
			forkSession: async (sessionId, messageID) => {
				const session = requireSuccess(
					await bridge.forkSession(sessionId, messageID),
					"Failed to fork session",
				);
				return tagClaudeSession(session);
			},
			revertSession: async () => {
				throw new Error("Claude Code backend does not support session revert");
			},
			unrevertSession: async () => {
				throw new Error("Claude Code backend does not support session revert");
			},
			listProviders: async (target) => {
				const { directory, workspaceId } = getTarget(target);
				return requireSuccess(
					await bridge.getProviders(directory, workspaceId),
					"Failed to list providers",
				);
			},
			listAgents: async (target) => {
				const { directory, workspaceId } = getTarget(target);
				return requireSuccess(
					await bridge.getAgents(directory, workspaceId),
					"Failed to list agents",
				);
			},
			listCommands: async (target) => {
				const { directory, workspaceId } = getTarget(target);
				return requireSuccess(
					await bridge.getCommands(directory, workspaceId),
					"Failed to list commands",
				);
			},
			sendCommand: async ({ sessionId, command, args, model, agent, variant }) => {
				requireSuccess(
					await bridge.sendCommand(
						sessionId,
						command,
						args,
						model,
						agent,
						variant,
					),
					"Failed to send command",
				);
			},
			respondPermission: async (sessionId, permissionId, response) => {
				requireSuccess(
					await bridge.respondPermission(sessionId, permissionId, response),
					"Failed to respond to permission request",
				);
			},
			replyQuestion: async () => {
				throw new Error("Claude Code backend does not support interactive questions");
			},
			rejectQuestion: async () => {
				throw new Error("Claude Code backend does not support interactive questions");
			},
			findFiles: async (target, query) => {
				return requireSuccess(
					await bridge.findFiles(target.directory ?? null, target.workspaceId, query),
					"Failed to find files",
				);
			},
			subscribe: (listener) =>
				bridge.onEvent((event) => {
					const normalized = normalizeClaudeCodeEvent(event);
					if (normalized) listener(normalized);
				}),
		},
	};
}
