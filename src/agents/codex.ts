import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { normalizeProjectPath } from "@/lib/utils"
import type { CodexBridge, NativeBackendEvent } from "@/types/electron"
import type {
	AgentBackendCapabilities,
	AgentBackendDescriptor,
	AgentBackendEvent,
	AgentBackendTarget,
} from "./backend"
import type { AgentBackendId } from "./index"

type SessionTags = {
	_projectDir?: string
	_workspaceId?: string
	_backendId?: AgentBackendId
	_rawId?: string
}

type TaggedSession = Session & SessionTags

export interface CodexBackendAdapter extends CodexBridge, AgentBackendDescriptor {
	native: CodexBridge
}

const CODEX_CAPABILITIES: AgentBackendCapabilities = {
	sessions: true,
	streaming: true,
	messagePaging: false,
	images: true,
	models: true,
	agents: false,
	commands: false,
	compact: false,
	fork: false,
	revert: false,
	permissions: false,
	questions: false,
	providerAuth: false,
	mcp: false,
	skills: false,
	config: false,
	localServer: false,
}

const CODEX_WORKSPACE = {
	kind: "local-cli",
	fields: {
		serverUrl: false,
		username: false,
		password: false,
		directory: true,
	},
} as const

function requireSuccess<T>(
	result:
		| { success: true; data?: T }
		| { success: false; error?: string }
		| { success: boolean; data?: T; error?: string },
	fallback: string,
): T {
	if (result.success) return result.data as T
	throw new Error(result.error ?? fallback)
}

function getTarget(target?: AgentBackendTarget) {
	return {
		directory: target?.directory,
		workspaceId: target?.workspaceId,
	}
}

function toCompositeSessionId(rawId: string) {
	return `codex:${rawId}`
}

function toRawSessionId(sessionId: string) {
	return sessionId.startsWith("codex:") ? sessionId.slice("codex:".length) : sessionId
}

function tagCodexSession(
	session: TaggedSession,
	target?: { directory?: string; workspaceId?: string },
): TaggedSession {
	const rawId = session._rawId ?? session.id
	const projectDir = target?.directory ?? session._projectDir ?? session.directory
	return {
		...session,
		id: toCompositeSessionId(rawId),
		_projectDir: projectDir ? normalizeProjectPath(projectDir) : undefined,
		_workspaceId:
			target?.workspaceId ??
			session._workspaceId ??
			("workspaceID" in session && typeof session.workspaceID === "string"
				? session.workspaceID
				: undefined),
		_backendId: "codex",
		_rawId: rawId,
	}
}

function normalizeMessage(message: Message): Message {
	return {
		...message,
		sessionID: toCompositeSessionId(message.sessionID),
	}
}

function normalizePart(part: Part): Part {
	return "sessionID" in part && typeof part.sessionID === "string"
		? ({ ...part, sessionID: toCompositeSessionId(part.sessionID) } as Part)
		: part
}

function normalizeCodexEventPayload(payload: AgentBackendEvent): AgentBackendEvent {
	switch (payload.type) {
		case "message.updated":
			return { ...payload, message: normalizeMessage(payload.message) }
		case "message.part.updated":
			return { ...payload, part: normalizePart(payload.part) }
		case "message.part.delta":
			return { ...payload, sessionID: toCompositeSessionId(payload.sessionID) }
		case "message.part.removed":
			return { ...payload, sessionID: toCompositeSessionId(payload.sessionID) }
		case "message.removed":
			return { ...payload, sessionID: toCompositeSessionId(payload.sessionID) }
		case "session.status":
			return { ...payload, sessionID: toCompositeSessionId(payload.sessionID) }
		case "permission.requested":
			return {
				...payload,
				request: {
					...payload.request,
					sessionID: toCompositeSessionId(payload.request.sessionID),
				},
			}
		case "permission.cleared":
			return { ...payload, sessionID: toCompositeSessionId(payload.sessionID) }
		case "question.requested":
			return {
				...payload,
				request: {
					...payload.request,
					sessionID: toCompositeSessionId(payload.request.sessionID),
				},
			}
		case "question.cleared":
			return { ...payload, sessionID: toCompositeSessionId(payload.sessionID) }
		default:
			return payload
	}
}

function normalizeCodexEvent(event: NativeBackendEvent): AgentBackendEvent | null {
	if (event.type === "connection:status") {
		return {
			type: "connection.status",
			directory: event.directory,
			workspaceId: event.workspaceId,
			status: event.payload,
		}
	}
	if (event.type !== "codex:event") return null
	const payload = (event.payload ?? null) as AgentBackendEvent | null
	if (!payload) return null
	if (payload.type === "session.created" || payload.type === "session.updated") {
		return {
			...payload,
			session: tagCodexSession(payload.session, {
				directory: payload.directory,
				workspaceId: payload.workspaceId,
			}),
		}
	}
	if (payload.type === "session.replaced") {
		return {
			...payload,
			oldId: toCompositeSessionId(payload.oldId),
			newId: toCompositeSessionId(payload.newId),
			session: tagCodexSession(payload.session, {
				directory: payload.directory,
				workspaceId: payload.workspaceId,
			}),
		}
	}
	if (payload.type === "session.deleted") {
		return { ...payload, sessionId: toCompositeSessionId(payload.sessionId) }
	}
	return normalizeCodexEventPayload(payload)
}

export function createCodexBackend(
	bridge?: CodexBridge,
): CodexBackendAdapter | undefined {
	if (!bridge) return undefined

	return {
		...bridge,
		id: "codex",
		label: "Codex",
		workspace: CODEX_WORKSPACE,
		capabilities: CODEX_CAPABILITIES,
		native: bridge,
		host: {
			addProject: async (config) => {
				requireSuccess(await bridge.addProject(config), "Failed to add project")
			},
			removeProject: async (target) => {
				requireSuccess(
					await bridge.removeProject(target.directory ?? "", target.workspaceId),
					"Failed to remove project",
				)
			},
			disconnect: async () => {
				requireSuccess(await bridge.disconnect(), "Failed to disconnect")
			},
		},
		runtime: {
			listSessions: async (target) => {
				const { directory, workspaceId } = getTarget(target)
				const sessions = requireSuccess<Session[]>(
					await bridge.listSessions(directory, workspaceId),
					"Failed to list sessions",
				)
				return sessions.map((session) =>
					tagCodexSession(session, {
						directory: directory ?? session.directory,
						workspaceId,
					}),
				)
			},
			createSession: async (input) => {
				const session = requireSuccess(
					await bridge.createSession(input?.title, input?.directory, input?.workspaceId),
					"Failed to create session",
				)
				return tagCodexSession(session, {
					directory: input?.directory ?? session.directory,
					workspaceId: input?.workspaceId,
				})
			},
			startSession: async (input) => {
				const session = requireSuccess(
					await bridge.startSession(input),
					"Failed to start session",
				)
				return tagCodexSession(session, {
					directory: input.directory ?? session.directory,
					workspaceId: input.workspaceId,
				})
			},
			deleteSession: async (sessionId) => {
				return requireSuccess(
					await bridge.deleteSession(toRawSessionId(sessionId)),
					"Failed to delete session",
				)
			},
			renameSession: async (sessionId, title) => {
				const session = requireSuccess(
					await bridge.updateSession(toRawSessionId(sessionId), title),
					"Failed to rename session",
				)
				return tagCodexSession(session)
			},
			listSessionStatuses: async (target) => {
				const { directory, workspaceId } = getTarget(target)
				const statuses = requireSuccess(
					await bridge.getSessionStatuses(directory, workspaceId),
					"Failed to list session statuses",
				)
				return Object.fromEntries(
					Object.entries(statuses).map(([sessionId, status]) => [
						toCompositeSessionId(sessionId),
						status,
					]),
				)
			},
			getMessages: async (sessionId, options) => {
				const { directory, workspaceId } = getTarget(options)
				const page = requireSuccess(
					await bridge.getMessages(
						toRawSessionId(sessionId),
						options,
						directory,
						workspaceId,
					),
					"Failed to get messages",
				)
				return {
					...page,
					messages: page.messages.map((entry) => ({
						info: normalizeMessage(entry.info),
						parts: entry.parts.map((part) => normalizePart(part)),
					})),
				}
			},
			prompt: async ({ sessionId, text, images, model, agent, variant }) => {
				requireSuccess(
					await bridge.prompt(
						toRawSessionId(sessionId),
						text,
						images,
						model,
						agent,
						variant,
					),
					"Failed to send prompt",
				)
			},
			abort: async (sessionId) => {
				requireSuccess(
					await bridge.abort(toRawSessionId(sessionId)),
					"Failed to abort session",
				)
			},
			compactSession: async (sessionId, model) => {
				requireSuccess(
					await bridge.summarizeSession(toRawSessionId(sessionId), model),
					"Failed to compact session",
				)
			},
			forkSession: async () => {
				throw new Error("Codex backend does not support session fork")
			},
			revertSession: async () => {
				throw new Error("Codex backend does not support session revert")
			},
			unrevertSession: async () => {
				throw new Error("Codex backend does not support session revert")
			},
			listProviders: async (target) => {
				const { directory, workspaceId } = getTarget(target)
				return requireSuccess(
					await bridge.getProviders(directory, workspaceId),
					"Failed to list providers",
				)
			},
			listAgents: async (target) => {
				const { directory, workspaceId } = getTarget(target)
				return requireSuccess(
					await bridge.getAgents(directory, workspaceId),
					"Failed to list agents",
				)
			},
			listCommands: async (target) => {
				const { directory, workspaceId } = getTarget(target)
				return requireSuccess(
					await bridge.getCommands(directory, workspaceId),
					"Failed to list commands",
				)
			},
			sendCommand: async ({ sessionId, command, args, model, agent, variant }) => {
				requireSuccess(
					await bridge.sendCommand(
						toRawSessionId(sessionId),
						command,
						args,
						model,
						agent,
						variant,
					),
					"Failed to send command",
				)
			},
			respondPermission: async () => {
				throw new Error("Codex backend does not support permission prompts")
			},
			replyQuestion: async () => {
				throw new Error("Codex backend does not support interactive questions")
			},
			rejectQuestion: async () => {
				throw new Error("Codex backend does not support interactive questions")
			},
			findFiles: async (target, query) => {
				const { directory, workspaceId } = getTarget(target)
				return requireSuccess(
					await bridge.findFiles(directory ?? null, workspaceId, query),
					"Failed to find files",
				)
			},
			subscribe: (listener) =>
				bridge.onEvent((event) => {
					const normalized = normalizeCodexEvent(event)
					if (normalized) listener(normalized)
				}),
		},
		platform: {},
	}
}
