import type { Event as OpenCodeEvent, QuestionAnswer, Session } from "@opencode-ai/sdk/v2/client";
import type {
	NativeBackendEvent,
	NativeAgentBridge,
	OpenCodeBridge,
	SelectedModel,
} from "@/types/electron";
import type {
	AgentBackendCapabilities,
	AgentBackendDescriptor,
	AgentBackendEvent,
	AgentBackendTarget,
} from "./backend";

export interface OpenCodeBackendAdapter extends OpenCodeBridge, AgentBackendDescriptor {
	native: OpenCodeBridge;
}

const OPENCODE_CAPABILITIES: AgentBackendCapabilities = {
	sessions: true,
	streaming: true,
	messagePaging: true,
	images: true,
	models: true,
	agents: true,
	commands: true,
	compact: true,
	fork: true,
	revert: true,
	permissions: true,
	questions: true,
	providerAuth: true,
	mcp: true,
	skills: true,
	config: true,
	localServer: true,
};

const OPENCODE_WORKSPACE = {
	kind: "remote-server",
	fields: {
		serverUrl: true,
		username: true,
		password: true,
		directory: true,
	},
} as const;

function getTarget(target?: AgentBackendTarget) {
	return {
		directory: target?.directory,
		workspaceId: target?.workspaceId,
	};
}

type SessionTags = {
	_projectDir?: string;
	_workspaceId?: string;
};

type TaggedSession = Session & SessionTags;

function tagSession(
	session: TaggedSession,
	event: { directory: string; workspaceId?: string },
): TaggedSession {
	return {
		...session,
		_projectDir: event.directory,
		_workspaceId: event.workspaceId,
	};
}

function normalizeOpenCodeEvent(event: NativeBackendEvent): AgentBackendEvent | null {
	if (event.type === "connection:status") {
		return {
			type: "connection.status",
			directory: event.directory,
			workspaceId: event.workspaceId,
			status: event.payload,
		};
	}

	if (event.type !== "opencode:event") return null;
	const oc = event.payload as OpenCodeEvent;

	switch (oc.type) {
		case "session.created":
			return {
				type: "session.created",
				directory: event.directory,
				workspaceId: event.workspaceId,
				session: tagSession(oc.properties.info, event),
			};
		case "session.updated":
			return {
				type: "session.updated",
				directory: event.directory,
				workspaceId: event.workspaceId,
				session: tagSession(oc.properties.info, event),
			};
		case "session.deleted":
			return {
				type: "session.deleted",
				directory: event.directory,
				workspaceId: event.workspaceId,
				sessionId: oc.properties.info.id,
			};
		case "message.updated":
			return { type: "message.updated", message: oc.properties.info };
		case "message.part.updated":
			return { type: "message.part.updated", part: oc.properties.part };
		case "message.part.delta":
			return {
				type: "message.part.delta",
				sessionID: oc.properties.sessionID,
				messageID: oc.properties.messageID,
				partID: oc.properties.partID,
				field: oc.properties.field,
				delta: oc.properties.delta,
			};
		case "message.part.removed":
			return {
				type: "message.part.removed",
				sessionID: oc.properties.sessionID,
				messageID: oc.properties.messageID,
				partID: oc.properties.partID,
			};
		case "message.removed":
			return {
				type: "message.removed",
				sessionID: oc.properties.sessionID,
				messageID: oc.properties.messageID,
			};
		case "session.status":
			return {
				type: "session.status",
				sessionID: oc.properties.sessionID,
				status: oc.properties.status,
			};
		case "permission.asked":
			return {
				type: "permission.requested",
				request: oc.properties,
			};
		case "permission.replied":
			return {
				type: "permission.cleared",
				sessionID: (oc.properties as { sessionID: string }).sessionID,
			};
		case "question.asked":
			return {
				type: "question.requested",
				request: oc.properties,
			};
		case "question.replied":
		case "question.rejected":
			return {
				type: "question.cleared",
				sessionID: (oc.properties as { sessionID: string }).sessionID,
			};
		case "session.error": {
			const errData = oc.properties.error;
			if (!errData || errData.name === "MessageAbortedError") return null;
			const errMsg =
				"data" in errData &&
				errData.data &&
				typeof errData.data === "object" &&
				"message" in errData.data
					? String((errData.data as { message: string }).message)
					: errData.name;
			return { type: "session.error", error: errMsg };
		}
		default:
			return null;
	}
}

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

export function createOpenCodeBackend(
	bridge?: NativeAgentBridge,
): OpenCodeBackendAdapter | undefined {
	if (!bridge) return undefined;

	const adapter: OpenCodeBackendAdapter = {
		...bridge,
		id: "opencode",
		label: "OpenCode",
		workspace: OPENCODE_WORKSPACE,
		capabilities: OPENCODE_CAPABILITIES,
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
				return requireSuccess(
					await bridge.listSessions(directory, workspaceId),
					"Failed to list sessions",
				);
			},
			createSession: async (input) => {
				return requireSuccess(
					await bridge.createSession(
						input?.title,
						input?.directory,
						input?.workspaceId,
					),
					"Failed to create session",
				);
			},
			startSession: async (input) => {
				const session = requireSuccess(
					await bridge.createSession(
						input.title,
						input.directory,
						input.workspaceId,
					),
					"Failed to create session",
				);
				requireSuccess(
					await bridge.prompt(
						session.id,
						input.text,
						input.images,
						input.model,
						input.agent,
						input.variant,
					),
					"Failed to start session",
				);
				return session;
			},
			deleteSession: async (sessionId) => {
				return requireSuccess(
					await bridge.deleteSession(sessionId),
					"Failed to delete session",
				);
			},
			renameSession: async (sessionId, title) => {
				return requireSuccess(
					await bridge.updateSession(sessionId, title),
					"Failed to rename session",
				);
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
					await bridge.prompt(sessionId, text, images, model, agent, variant),
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
				return requireSuccess(
					await bridge.forkSession(sessionId, messageID),
					"Failed to fork session",
				);
			},
			revertSession: async (sessionId, messageID, partID) => {
				return requireSuccess(
					await bridge.revertSession(sessionId, messageID, partID),
					"Failed to revert session",
				);
			},
			unrevertSession: async (sessionId) => {
				return requireSuccess(
					await bridge.unrevertSession(sessionId),
					"Failed to unrevert session",
				);
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
					await bridge.sendCommand(sessionId, command, args, model, agent, variant),
					"Failed to send command",
				);
			},
			respondPermission: async (sessionId, permissionId, response) => {
				requireSuccess(
					await bridge.respondPermission(sessionId, permissionId, response),
					"Failed to respond to permission request",
				);
			},
			replyQuestion: async (requestID: string, answers: QuestionAnswer[]) => {
				requireSuccess(
					await bridge.replyQuestion(requestID, answers),
					"Failed to reply to question",
				);
			},
			rejectQuestion: async (requestID: string) => {
				requireSuccess(
					await bridge.rejectQuestion(requestID),
					"Failed to reject question",
				);
			},
			findFiles: async (target, query) => {
				const { directory, workspaceId } = getTarget(target);
				return requireSuccess(
					await bridge.findFiles(directory ?? null, workspaceId, query),
					"Failed to find files",
				);
			},
			subscribe: (listener) =>
				bridge.onEvent((event) => {
					const normalized = normalizeOpenCodeEvent(event);
					if (normalized) listener(normalized);
				}),
		},
		platform: {
			server: {
				start: async () =>
					requireSuccess(await bridge.startServer(), "Failed to start server"),
				stop: async () =>
					requireSuccess(await bridge.stopServer(), "Failed to stop server"),
				status: async () =>
					requireSuccess(
						await bridge.getServerStatus(),
						"Failed to get server status",
					),
			},
			providers: {
				listAll: async (target) => {
					const { directory, workspaceId } = getTarget(target);
					return requireSuccess(
						await bridge.listAllProviders(directory, workspaceId),
						"Failed to list providers",
					);
				},
				getAuthMethods: async (target) => {
					const { directory, workspaceId } = getTarget(target);
					return requireSuccess(
						await bridge.getProviderAuthMethods(directory, workspaceId),
						"Failed to get provider auth methods",
					);
				},
				connect: async (target, providerID, auth) => {
					const { directory, workspaceId } = getTarget(target);
					requireSuccess(
						await bridge.connectProvider(directory, workspaceId, providerID, auth),
						"Failed to connect provider",
					);
				},
				disconnect: async (target, providerID) => {
					const { directory, workspaceId } = getTarget(target);
					requireSuccess(
						await bridge.disconnectProvider(directory, workspaceId, providerID),
						"Failed to disconnect provider",
					);
				},
				oauthAuthorize: async (target, providerID, method) => {
					const { directory, workspaceId } = getTarget(target);
					return requireSuccess(
						await bridge.oauthAuthorize(directory, workspaceId, providerID, method),
						"Failed to authorize provider",
					);
				},
				oauthCallback: async (target, providerID, method, code) => {
					const { directory, workspaceId } = getTarget(target);
					return requireSuccess(
						await bridge.oauthCallback(
							directory,
							workspaceId,
							providerID,
							method,
							code,
						),
						"Failed to complete provider auth",
					);
				},
				dispose: async (target) => {
					const { directory, workspaceId } = getTarget(target);
					return requireSuccess(
						await bridge.disposeInstance(directory, workspaceId),
						"Failed to dispose provider instance",
					);
				},
			},
			mcp: {
				status: async (target) => {
					const { directory, workspaceId } = getTarget(target);
					return requireSuccess(
						await bridge.getMcpStatus(directory, workspaceId),
						"Failed to get MCP status",
					);
				},
				add: async (target, name, config) => {
					const { directory, workspaceId } = getTarget(target);
					return requireSuccess(
						await bridge.addMcp(directory, workspaceId, name, config),
						"Failed to add MCP server",
					);
				},
				connect: async (target, name) => {
					const { directory, workspaceId } = getTarget(target);
					requireSuccess(
						await bridge.connectMcp(directory, workspaceId, name),
						"Failed to connect MCP server",
					);
				},
				disconnect: async (target, name) => {
					const { directory, workspaceId } = getTarget(target);
					requireSuccess(
						await bridge.disconnectMcp(directory, workspaceId, name),
						"Failed to disconnect MCP server",
					);
				},
			},
			skills: {
				list: async (target) => {
					const { directory, workspaceId } = getTarget(target);
					return requireSuccess(
						await bridge.getSkills(directory, workspaceId),
						"Failed to get skills",
					);
				},
			},
			config: {
				get: async (target) => {
					const { directory, workspaceId } = getTarget(target);
					return requireSuccess(
						await bridge.getConfig(directory, workspaceId),
						"Failed to get config",
					);
				},
				update: async (target, config) => {
					const { directory, workspaceId } = getTarget(target);
					return requireSuccess(
						await bridge.updateConfig(directory, workspaceId, config),
						"Failed to update config",
					);
				},
			},
		},
	};

	return adapter;
}

export function toOpenCodeTarget(
	directory?: string,
	workspaceId?: string,
): AgentBackendTarget {
	return { directory, workspaceId };
}

export function toOpenCodePromptOptions(input: {
	model?: SelectedModel | null;
	agent?: string | null;
	variant?: string;
}) {
	return {
		model: input.model ?? undefined,
		agent: input.agent ?? undefined,
		variant: input.variant,
	};
}
