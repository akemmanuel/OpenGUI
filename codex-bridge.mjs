import { execFile as execFileCallback } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, normalize } from "node:path"
import { promisify } from "node:util"
import { app } from "electron"
import { Codex } from "@openai/codex-sdk"

const execFile = promisify(execFileCallback)

const DEFAULT_STATUS = {
	state: "idle",
	serverUrl: null,
	serverVersion: null,
	error: null,
	lastEventAt: null,
}

const CODEX_VARIANTS = ["minimal", "low", "medium", "high", "xhigh"]
const DEFAULT_MODEL_ID = "gpt-5.4"
const DEFAULT_PROVIDER_ID = "openai"

const CODEX_PROVIDER = {
	providers: [
		{
			id: DEFAULT_PROVIDER_ID,
			name: "OpenAI",
			source: "api",
			env: ["CODEX_API_KEY", "OPENAI_API_KEY"],
			options: {},
			models: {
				"gpt-5.4": makeModel("gpt-5.4", "GPT-5.4", {
					reasoning: true,
					image: true,
					releaseDate: "2026-04-01",
				}),
				"gpt-5.4-mini": makeModel("gpt-5.4-mini", "GPT-5.4 Mini", {
					reasoning: true,
					image: true,
					releaseDate: "2026-04-01",
				}),
				"gpt-5.4-nano": makeModel("gpt-5.4-nano", "GPT-5.4 Nano", {
					reasoning: false,
					image: true,
					releaseDate: "2026-04-01",
				}),
				"gpt-5.3-codex": makeModel("gpt-5.3-codex", "GPT-5.3 Codex", {
					reasoning: true,
					image: true,
					releaseDate: "2026-03-01",
				}),
			},
		},
	],
	default: {
		[DEFAULT_PROVIDER_ID]: DEFAULT_MODEL_ID,
	},
}

function makeModel(id, name, { reasoning, image, releaseDate }) {
	return {
		id,
		providerID: DEFAULT_PROVIDER_ID,
		api: {
			id,
			url: "https://api.openai.com",
			npm: "@openai/codex-sdk",
		},
		name,
		family: id,
		capabilities: {
			temperature: false,
			reasoning,
			attachment: image,
			toolcall: true,
			input: {
				text: true,
				audio: false,
				image,
				video: false,
				pdf: false,
			},
			output: {
				text: true,
				audio: false,
				image: false,
				video: false,
				pdf: false,
			},
			interleaved: false,
		},
		cost: {
			input: 0,
			output: 0,
			cache: { read: 0, write: 0 },
		},
		limit: {
			context: 200_000,
			output: 8_192,
		},
		status: "active",
		options: {},
		headers: {},
		release_date: releaseDate,
		variants: Object.fromEntries(
			CODEX_VARIANTS.map((variant) => [variant, { label: variant }]),
		),
	}
}

function normalizeDir(directory) {
	if (typeof directory !== "string") return ""
	const trimmed = directory.trim()
	if (!trimmed) return ""
	return normalize(trimmed)
}

function makeProjectKey(workspaceId, directory) {
	return `${workspaceId ?? "local"}:${normalizeDir(directory)}`
}

function ok(data) {
	return { success: true, data }
}

function fail(error, data) {
	return {
		success: false,
		error: error instanceof Error ? error.message : String(error),
		data,
	}
}

function nowConnection(status = {}) {
	return {
		...DEFAULT_STATUS,
		...status,
		lastEventAt: Date.now(),
	}
}

function sessionStatus(type) {
	return { type }
}

function firstLine(text) {
	return String(text ?? "").trim().split(/\r?\n/, 1)[0] ?? ""
}

function makeSessionTitle(text, title) {
	const explicit = typeof title === "string" ? title.trim() : ""
	if (explicit) return explicit
	const line = firstLine(text)
	return line.slice(0, 80) || "Untitled"
}

function resolveSelectedModelId(selectedModel) {
	if (selectedModel?.modelID && typeof selectedModel.modelID === "string") {
		return selectedModel.modelID
	}
	return DEFAULT_MODEL_ID
}

function resolveVariant(variant) {
	if (typeof variant !== "string") return undefined
	return CODEX_VARIANTS.includes(variant) ? variant : undefined
}

function defaultUserInfo(sessionId, messageId, modelId, variant, createdAt = Date.now()) {
	return {
		id: messageId,
		sessionID: sessionId,
		role: "user",
		time: { created: createdAt },
		agent: "codex",
		model: {
			providerID: DEFAULT_PROVIDER_ID,
			modelID: modelId,
			...(variant ? { variant } : {}),
		},
	}
}

function defaultAssistantInfo(
	sessionId,
	messageId,
	directory,
	modelId,
	variant,
	createdAt = Date.now(),
) {
	return {
		id: messageId,
		sessionID: sessionId,
		role: "assistant",
		time: { created: createdAt },
		parentID: "",
		modelID: modelId,
		providerID: DEFAULT_PROVIDER_ID,
		mode: "codex",
		agent: "codex",
		path: {
			cwd: directory,
			root: directory,
		},
		cost: 0,
		tokens: {
			input: 0,
			output: 0,
			reasoning: 0,
			cache: { read: 0, write: 0 },
		},
		...(variant ? { variant } : {}),
	}
}

function makeTextPart(sessionId, messageId, partId, text, synthetic = false) {
	return {
		id: partId,
		sessionID: sessionId,
		messageID: messageId,
		type: "text",
		text,
		...(synthetic ? { synthetic: true } : {}),
	}
}

function makeReasoningPart(sessionId, messageId, partId, text, start = Date.now()) {
	return {
		id: partId,
		sessionID: sessionId,
		messageID: messageId,
		type: "reasoning",
		text,
		time: { start },
	}
}

function parseDataUrl(dataUrl) {
	if (typeof dataUrl !== "string") return null
	const match = dataUrl.match(/^data:([^;,]+)?;base64,(.+)$/)
	if (!match) return null
	return {
		mimeType: match[1] || "application/octet-stream",
		data: match[2],
	}
}

function mimeToExtension(mimeType) {
	switch (mimeType) {
		case "image/png":
			return ".png"
		case "image/jpeg":
		case "image/jpg":
			return ".jpg"
		case "image/gif":
			return ".gif"
		case "image/webp":
			return ".webp"
		default:
			return ".bin"
	}
}

function createUserImageParts(sessionId, messageId, images) {
	return (Array.isArray(images) ? images : [])
		.map((image, index) => {
			const parsed = parseDataUrl(image)
			if (!parsed) return null
			return {
				id: randomUUID(),
				sessionID: sessionId,
				messageID: messageId,
				type: "file",
				mime: parsed.mimeType,
				filename: `image-${index + 1}${mimeToExtension(parsed.mimeType)}`,
				url: image,
			}
		})
		.filter(Boolean)
}

function stringifyUnknown(value) {
	if (typeof value === "string") return value
	if (value == null) return ""
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

function mcpContentToText(result) {
	if (!result || !Array.isArray(result.content)) return stringifyUnknown(result?.structured_content)
	const parts = []
	for (const block of result.content) {
		if (!block || typeof block !== "object") continue
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text)
			continue
		}
		if (block.type === "image") {
			parts.push("[image]")
			continue
		}
		parts.push(stringifyUnknown(block))
	}
	const joined = parts.join("\n\n").trim()
	return joined || stringifyUnknown(result?.structured_content)
}

function cloneJSON(value) {
	return JSON.parse(JSON.stringify(value))
}

function sanitizeFileName(id) {
	return encodeURIComponent(id).replace(/%/g, "_")
}

function makeStoragePaths() {
	const root = join(app.getPath("userData"), "codex")
	return {
		root,
		indexFile: join(root, "sessions.json"),
		transcriptsDir: join(root, "transcripts"),
	}
}

function pickCodexEnv(source) {
	const env = {}
	const allow = new Set([
		"PATH",
		"HOME",
		"USERPROFILE",
		"SHELL",
		"TMPDIR",
		"TMP",
		"TEMP",
		"SSL_CERT_FILE",
	])
	for (const [key, value] of Object.entries(source ?? {})) {
		if (typeof value !== "string") continue
		if (
			allow.has(key) ||
			key.startsWith("CODEX_") ||
			key.startsWith("OPENAI_") ||
			key === "HTTP_PROXY" ||
			key === "HTTPS_PROXY" ||
			key === "NO_PROXY"
		) {
			env[key] = value
		}
	}
	return env
}

function getMessageText(bundle) {
	if (!bundle || !Array.isArray(bundle.parts)) return ""
	return bundle.parts
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n\n")
		.trim()
}

function getSessionPreview(messages) {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const text = getMessageText(messages[i])
		if (text) return firstLine(text).slice(0, 160)
	}
	return ""
}

function upsertMessage(messages, info) {
	let bundle = messages.find((entry) => entry.info.id === info.id)
	if (!bundle) {
		bundle = { info, parts: [] }
		messages.push(bundle)
		return bundle
	}
	bundle.info = info
	return bundle
}

function findMessage(messages, messageId) {
	return messages.find((entry) => entry.info.id === messageId) ?? null
}

function upsertPart(messages, part) {
	const bundle = findMessage(messages, part.messageID)
	if (!bundle) return null
	const index = bundle.parts.findIndex((entry) => entry.id === part.id)
	if (index === -1) {
		bundle.parts.push(part)
		return part
	}
	bundle.parts[index] = part
	return part
}

function findPart(messages, messageId, partId) {
	const bundle = findMessage(messages, messageId)
	if (!bundle) return null
	return bundle.parts.find((part) => part.id === partId) ?? null
}

function renameSessionInMessages(messages, oldId, newId) {
	for (const bundle of messages) {
		bundle.info = { ...bundle.info, sessionID: newId }
		bundle.parts = bundle.parts.map((part) => ({ ...part, sessionID: newId }))
	}
}

function summarizeFileChanges(changes) {
	return (Array.isArray(changes) ? changes : []).map((change) => ({
		filePath: change.path,
		relativePath: change.path,
		type: change.kind,
		additions: change.kind === "add" ? 1 : change.kind === "update" ? 1 : 0,
		deletions: change.kind === "delete" ? 1 : change.kind === "update" ? 1 : 0,
	}))
}

function buildToolPartFromItem(sessionId, messageId, item, existingPart, phase) {
	const now = Date.now()
	const base = {
		id: existingPart?.id ?? `${messageId}:tool:${item.id}`,
		sessionID: sessionId,
		messageID: messageId,
		type: "tool",
		callID: item.id,
	}

	if (item.type === "command_execution") {
		const isDone = item.status === "completed" || item.status === "failed"
		return {
			...base,
			tool: "shell",
			state: isDone
				? {
					status: item.status === "failed" ? "error" : "completed",
					input: { command: item.command },
					...(item.status === "failed"
						? { error: item.aggregated_output || `Command failed: ${item.command}` }
						: { output: item.aggregated_output || "" }),
					metadata: {
						exitCode: item.exit_code,
						output: item.aggregated_output || "",
					},
					time: {
						start: existingPart?.state?.time?.start ?? now,
						end: now,
					},
				}
				: {
					status: "running",
					input: { command: item.command },
					title: item.command,
					metadata: {
						output: item.aggregated_output || "",
						exitCode: item.exit_code,
					},
					time: {
						start: existingPart?.state?.time?.start ?? now,
					},
				},
		}
	}

	if (item.type === "file_change") {
		const failed = item.status === "failed"
		return {
			...base,
			tool: "apply_patch",
			state: failed
				? {
					status: "error",
					input: {},
					error: "Failed to apply file changes",
					metadata: { files: summarizeFileChanges(item.changes) },
					time: {
						start: existingPart?.state?.time?.start ?? now,
						end: now,
					},
				}
				: {
					status: "completed",
					input: {},
					output: "",
					title: "apply_patch",
					metadata: { files: summarizeFileChanges(item.changes) },
					time: {
						start: existingPart?.state?.time?.start ?? now,
						end: now,
					},
				},
		}
	}

	if (item.type === "mcp_tool_call") {
		const isDone = item.status === "completed" || item.status === "failed"
		const toolName = `${item.server}:${item.tool}`
		return {
			...base,
			tool: toolName,
			state: isDone
				? item.status === "failed"
					? {
						status: "error",
						input: item.arguments ?? {},
						error: item.error?.message || "MCP tool call failed",
						metadata: {
							server: item.server,
							tool: item.tool,
						},
						time: {
							start: existingPart?.state?.time?.start ?? now,
							end: now,
						},
					}
					: {
						status: "completed",
						input: item.arguments ?? {},
						output: mcpContentToText(item.result),
						title: toolName,
						metadata: {
							server: item.server,
							tool: item.tool,
							result: item.result?.structured_content,
						},
						time: {
							start: existingPart?.state?.time?.start ?? now,
							end: now,
						},
					}
				: {
					status: "running",
					input: item.arguments ?? {},
					title: toolName,
					metadata: {
						server: item.server,
						tool: item.tool,
					},
					time: {
						start: existingPart?.state?.time?.start ?? now,
					},
				},
		}
	}

	if (item.type === "web_search") {
		return {
			...base,
			tool: "web_search",
			state:
				phase === "completed"
					? {
						status: "completed",
						input: { query: item.query },
						output: "",
						title: "web_search",
						metadata: {},
						time: {
							start: existingPart?.state?.time?.start ?? now,
							end: now,
						},
					}
					: {
						status: "running",
						input: { query: item.query },
						title: "web_search",
						metadata: {},
						time: {
							start: existingPart?.state?.time?.start ?? now,
						},
					},
		}
	}

	if (item.type === "todo_list") {
		const todos = (Array.isArray(item.items) ? item.items : []).map((todo) => ({
			content: todo.text,
			status: todo.completed ? "completed" : "pending",
			priority: "medium",
		}))
		return {
			...base,
			tool: "todowrite",
			state:
				phase === "completed"
					? {
						status: "completed",
						input: { todos },
						output: "",
						title: "todowrite",
						metadata: {},
						time: {
							start: existingPart?.state?.time?.start ?? now,
							end: now,
						},
					}
					: {
						status: "running",
						input: { todos },
						title: "todowrite",
						metadata: {},
						time: {
							start: existingPart?.state?.time?.start ?? now,
						},
					},
		}
	}

	return {
		...base,
		tool: item.type,
		state: {
			status: "completed",
			input: { item: stringifyUnknown(item) },
			output: "",
			title: item.type,
			metadata: {},
			time: {
				start: existingPart?.state?.time?.start ?? now,
				end: now,
			},
		},
	}
}

class CodexBridgeManager {
	constructor(getAllWindows) {
		this.getAllWindows = getAllWindows
		this.projects = new Map()
		this.sessionIndex = new Map()
		this.transcriptCache = new Map()
		this.liveSessions = new Map()
		this.aliases = new Map()
		this.paths = makeStoragePaths()
		this.storageReady = this.loadStorage()
		this.codex = new Codex({
			env: pickCodexEnv(process.env),
		})
	}

	emit(event) {
		for (const window of this.getAllWindows()) {
			if (!window || window.isDestroyed()) continue
			window.webContents.send("codex:bridge-event", event)
		}
	}

	emitConnection(project, status) {
		this.emit({
			type: "connection:status",
			directory: project.directory,
			workspaceId: project.workspaceId,
			payload: status,
		})
	}

	emitBackend(project, payload) {
		this.emit({
			type: "codex:event",
			directory: project?.directory,
			workspaceId: project?.workspaceId,
			payload,
		})
	}

	async loadStorage() {
		await mkdir(this.paths.root, { recursive: true })
		await mkdir(this.paths.transcriptsDir, { recursive: true })
		try {
			const raw = await readFile(this.paths.indexFile, "utf8")
			const parsed = JSON.parse(raw)
			if (!Array.isArray(parsed)) return
			for (const entry of parsed) {
				if (!entry || typeof entry !== "object") continue
				if (typeof entry.id !== "string") continue
				this.sessionIndex.set(entry.id, entry)
			}
		} catch {
			/* ignore */
		}
	}

	async persistIndex() {
		await this.storageReady
		const entries = [...this.sessionIndex.values()].sort(
			(a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
		)
		await writeFile(this.paths.indexFile, JSON.stringify(entries, null, 2), "utf8")
	}

	transcriptFile(sessionId) {
		return join(this.paths.transcriptsDir, `${sanitizeFileName(sessionId)}.json`)
	}

	clearSessionMemory(sessionId) {
		const realId = this.resolveSessionId(sessionId)
		this.liveSessions.delete(sessionId)
		this.liveSessions.delete(realId)
		this.transcriptCache.delete(sessionId)
		this.transcriptCache.delete(realId)
		for (const [alias, target] of this.aliases.entries()) {
			if (alias === sessionId || alias === realId || target === sessionId || target === realId) {
				this.aliases.delete(alias)
			}
		}
	}

	clearProjectMemory(directory, workspaceId) {
		for (const [sessionId, live] of this.liveSessions.entries()) {
			if (live.project.directory === directory && live.project.workspaceId === workspaceId) {
				this.clearSessionMemory(sessionId)
			}
		}
		for (const [sessionId, record] of this.sessionIndex.entries()) {
			if (record.directory === directory && record.workspaceId === workspaceId) {
				this.transcriptCache.delete(sessionId)
				for (const [alias, target] of this.aliases.entries()) {
					if (alias === sessionId || target === sessionId) {
						this.aliases.delete(alias)
					}
				}
			}
		}
	}

	async loadTranscript(sessionId) {
		const realId = this.resolveSessionId(sessionId)
		if (this.transcriptCache.has(realId)) {
			return this.transcriptCache.get(realId)
		}
		try {
			const raw = await readFile(this.transcriptFile(realId), "utf8")
			const parsed = JSON.parse(raw)
			const messages = Array.isArray(parsed?.messages) ? parsed.messages : []
			const cached = { messages }
			this.transcriptCache.set(realId, cached)
			return cached
		} catch {
			const empty = { messages: [] }
			this.transcriptCache.set(realId, empty)
			return empty
		}
	}

	async persistTranscript(sessionId, messages) {
		await this.storageReady
		const realId = this.resolveSessionId(sessionId)
		const payload = { messages }
		this.transcriptCache.set(realId, payload)
		await writeFile(this.transcriptFile(realId), JSON.stringify(payload, null, 2), "utf8")
	}

	resolveSessionId(sessionId) {
		let current = sessionId
		while (this.aliases.has(current)) {
			current = this.aliases.get(current)
		}
		return current
	}

	getLiveSession(sessionId) {
		const direct = this.liveSessions.get(sessionId)
		if (direct) return direct
		const resolved = this.resolveSessionId(sessionId)
		return this.liveSessions.get(resolved) ?? null
	}

	buildSession({ id, directory, workspaceId, title, createdAt, updatedAt }) {
		return {
			id,
			slug: id,
			projectID: directory,
			workspaceID: workspaceId,
			directory,
			title: title || "Untitled",
			version: "codex",
			time: {
				created: createdAt,
				updated: updatedAt,
			},
		}
	}

	buildSessionFromRecord(record) {
		return this.buildSession({
			id: record.id,
			directory: record.directory,
			workspaceId: record.workspaceId,
			title: record.title,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
		})
	}

	ensureKnownProject(directory, workspaceId) {
		const normalized = normalizeDir(directory)
		if (!normalized) {
			throw new Error("Codex requires a project directory")
		}
		const key = makeProjectKey(workspaceId, normalized)
		let project = this.projects.get(key)
		if (!project) {
			project = { key, directory: normalized, workspaceId }
			this.projects.set(key, project)
		}
		return project
	}

	async addProject(config) {
		const project = this.ensureKnownProject(config?.directory, config?.workspaceId)
		try {
			const info = await stat(project.directory)
			if (!info.isDirectory()) {
				throw new Error(`${project.directory} is not a directory`)
			}
		} catch (error) {
			this.emitConnection(project, nowConnection({
				state: "error",
				error: error instanceof Error ? error.message : String(error),
			}))
			throw error
		}
		this.emitConnection(project, nowConnection({ state: "connected" }))
	}

	async removeProject(target) {
		const directory = normalizeDir(target?.directory)
		if (!directory) return
		const key = makeProjectKey(target?.workspaceId, directory)
		const workspaceId = target?.workspaceId
		const project = this.projects.get(key) ?? { directory, workspaceId }
		this.clearProjectMemory(directory, workspaceId)
		this.projects.delete(key)
		this.emitConnection(project, nowConnection({ state: "idle" }))
	}

	disconnect() {
		for (const project of this.projects.values()) {
			this.emitConnection(project, nowConnection({ state: "idle" }))
		}
		this.projects.clear()
		this.liveSessions.clear()
		this.transcriptCache.clear()
		this.aliases.clear()
	}

	async listSessions(target = {}) {
		await this.storageReady
		const directory = normalizeDir(target.directory)
		const workspaceId = target.workspaceId
		const byId = new Map()
		for (const live of this.liveSessions.values()) {
			if (live.hidden) continue
			if (directory && live.project.directory !== directory) continue
			if (workspaceId !== undefined && live.project.workspaceId !== workspaceId) continue
			byId.set(live.session.id, live.session)
		}
		for (const record of this.sessionIndex.values()) {
			if (record.hidden) continue
			if (directory && record.directory !== directory) continue
			if (workspaceId !== undefined && record.workspaceId !== workspaceId) continue
			byId.set(record.id, this.buildSessionFromRecord(record))
		}
		return [...byId.values()].sort(
			(a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0),
		)
	}

	async createSession(input = {}) {
		const project = this.ensureKnownProject(input.directory, input.workspaceId)
		const now = Date.now()
		const tempId = `codex:temp:${randomUUID()}`
		const session = this.buildSession({
			id: tempId,
			directory: project.directory,
			workspaceId: project.workspaceId,
			title: makeSessionTitle("", input.title),
			createdAt: now,
			updatedAt: now,
		})
		const live = {
			sessionId: tempId,
			threadId: null,
			project,
			session,
			messages: [],
			running: false,
			abortController: null,
			currentAssistantMessageId: null,
			currentUserMessageId: null,
			currentModelId: DEFAULT_MODEL_ID,
			currentVariant: undefined,
			createdAt: now,
			hidden: false,
		}
		this.liveSessions.set(tempId, live)
		this.emitBackend(project, {
			type: "session.created",
			directory: project.directory,
			workspaceId: project.workspaceId,
			session,
		})
		return session
	}

	async startSession(input = {}) {
		const session = await this.createSession(input)
		try {
			await this.prompt(
				session.id,
				input.text ?? "",
				input.images,
				input.model,
				input.agent,
				input.variant,
				input.directory,
				input.workspaceId,
			)
			return session
		} catch (error) {
			await this.deleteSession(session.id, { directory: input.directory, workspaceId: input.workspaceId })
			throw error
		}
	}

	async deleteSession(sessionId, _target = {}) {
		await this.storageReady
		const live = this.getLiveSession(sessionId)
		if (live?.running) {
			throw new Error("Stop Codex session before deleting it.")
		}
		if (live && !live.threadId) {
			live.hidden = true
			this.clearSessionMemory(live.session.id)
			this.emitBackend(live.project, {
				type: "session.deleted",
				directory: live.project.directory,
				workspaceId: live.project.workspaceId,
				sessionId: live.session.id,
			})
			return true
		}
		const realId = this.resolveSessionId(sessionId)
		const record = this.sessionIndex.get(realId)
		if (!record) return true
		record.hidden = true
		this.sessionIndex.set(realId, record)
		if (live) {
			live.hidden = true
		}
		this.clearSessionMemory(sessionId)
		await this.persistIndex()
		const project = this.ensureKnownProject(record.directory, record.workspaceId)
		this.emitBackend(project, {
			type: "session.deleted",
			directory: project.directory,
			workspaceId: project.workspaceId,
			sessionId: realId,
		})
		return true
	}

	async updateSession(sessionId, title, _target = {}) {
		const trimmed = String(title ?? "").trim()
		if (!trimmed) throw new Error("Session title cannot be empty")
		const live = this.getLiveSession(sessionId)
		if (live) {
			live.session = {
				...live.session,
				title: trimmed,
				time: { ...live.session.time, updated: Date.now() },
			}
			if (live.threadId) {
				const record = this.sessionIndex.get(live.threadId) ?? {
					id: live.threadId,
					directory: live.project.directory,
					workspaceId: live.project.workspaceId,
					createdAt: live.createdAt,
					updatedAt: Date.now(),
					preview: "",
					origin: "opengui",
				}
				record.title = trimmed
				record.updatedAt = Date.now()
				this.sessionIndex.set(live.threadId, record)
				await this.persistIndex()
			}
			this.emitBackend(live.project, {
				type: "session.updated",
				directory: live.project.directory,
				workspaceId: live.project.workspaceId,
				session: live.session,
			})
			return live.session
		}
		const realId = this.resolveSessionId(sessionId)
		const record = this.sessionIndex.get(realId)
		if (!record) throw new Error("Codex session not found")
		record.title = trimmed
		record.updatedAt = Date.now()
		this.sessionIndex.set(realId, record)
		await this.persistIndex()
		const session = this.buildSessionFromRecord(record)
		const project = this.ensureKnownProject(record.directory, record.workspaceId)
		this.emitBackend(project, {
			type: "session.updated",
			directory: project.directory,
			workspaceId: project.workspaceId,
			session,
		})
		return session
	}

	async getSessionStatuses(target = {}) {
		const statuses = {}
		for (const session of await this.listSessions(target)) {
			const live = this.getLiveSession(session.id)
			statuses[session.id] = sessionStatus(live?.running ? "busy" : "idle")
		}
		return statuses
	}

	async getProviders() {
		return CODEX_PROVIDER
	}

	async getAgents() {
		return []
	}

	async getCommands() {
		return []
	}

	async getMessages(sessionId) {
		const live = this.getLiveSession(sessionId)
		if (live) {
			return {
				messages: cloneJSON(live.messages),
				nextCursor: null,
			}
		}
		const transcript = await this.loadTranscript(sessionId)
		return {
			messages: cloneJSON(transcript.messages),
			nextCursor: null,
		}
	}

	async ensureLiveSessionForPrompt(sessionId, directory, workspaceId) {
		const live = this.getLiveSession(sessionId)
		if (live) return live
		const realId = this.resolveSessionId(sessionId)
		const record = this.sessionIndex.get(realId)
		if (!record) throw new Error("Codex session not found")
		const project = this.ensureKnownProject(
			directory || record.directory,
			workspaceId ?? record.workspaceId,
		)
		const session = this.buildSessionFromRecord(record)
		const cached = await this.loadTranscript(realId)
		const createdAt = record.createdAt ?? Date.now()
		const state = {
			sessionId: realId,
			threadId: realId,
			project,
			session,
			messages: cloneJSON(cached.messages),
			running: false,
			abortController: null,
			currentAssistantMessageId: null,
			currentUserMessageId: null,
			currentModelId: DEFAULT_MODEL_ID,
			currentVariant: undefined,
			createdAt,
			hidden: false,
		}
		this.liveSessions.set(realId, state)
		return state
	}

	appendSyntheticUserMessage(state, text, images, model, variant) {
		const messageId = randomUUID()
		const modelId = resolveSelectedModelId(model)
		state.currentModelId = modelId
		state.currentVariant = resolveVariant(variant)
		const info = defaultUserInfo(
			state.session.id,
			messageId,
			modelId,
			state.currentVariant,
		)
		const parts = [
			makeTextPart(state.session.id, messageId, randomUUID(), String(text ?? ""), true),
			...createUserImageParts(state.session.id, messageId, images),
		]
		const bundle = { info, parts }
		state.messages.push(bundle)
		state.currentUserMessageId = messageId
		this.emitBackend(state.project, { type: "message.updated", message: info })
		for (const part of parts) {
			this.emitBackend(state.project, { type: "message.part.updated", part })
		}
	}

	ensureAssistantMessage(state) {
		if (state.currentAssistantMessageId) {
			const existing = findMessage(state.messages, state.currentAssistantMessageId)
			if (existing) return existing
		}
		const messageId = randomUUID()
		const info = defaultAssistantInfo(
			state.session.id,
			messageId,
			state.project.directory,
			state.currentModelId,
			state.currentVariant,
		)
		info.parentID = state.currentUserMessageId ?? ""
		const bundle = upsertMessage(state.messages, info)
		state.currentAssistantMessageId = messageId
		this.emitBackend(state.project, { type: "message.updated", message: info })
		return bundle
	}

	emitSessionUpdated(state) {
		this.emitBackend(state.project, {
			type: "session.updated",
			directory: state.project.directory,
			workspaceId: state.project.workspaceId,
			session: state.session,
		})
	}

	async syncRealSessionRecord(state, emitEvent = true) {
		if (!state.threadId) return
		const now = Date.now()
		const preview = getSessionPreview(state.messages)
		const existing = this.sessionIndex.get(state.threadId)
		const title =
			state.session.title && state.session.title !== "Untitled"
				? state.session.title
				: makeSessionTitle(preview, existing?.title)
		const record = {
			id: state.threadId,
			directory: state.project.directory,
			workspaceId: state.project.workspaceId,
			title,
			preview,
			createdAt: existing?.createdAt ?? state.createdAt,
			updatedAt: now,
			origin: "opengui",
			hidden: existing?.hidden ?? false,
		}
		this.sessionIndex.set(state.threadId, record)
		state.session = this.buildSessionFromRecord(record)
		state.sessionId = state.threadId
		await this.persistIndex()
		await this.persistTranscript(state.threadId, state.messages)
		if (emitEvent) {
			this.emitSessionUpdated(state)
		}
	}

	async handleThreadStarted(state, threadId) {
		if (!threadId || state.threadId === threadId) return
		const oldId = state.session.id
		state.threadId = threadId
		state.sessionId = threadId
		state.session = this.buildSession({
			id: threadId,
			directory: state.project.directory,
			workspaceId: state.project.workspaceId,
			title: state.session.title,
			createdAt: state.createdAt,
			updatedAt: Date.now(),
		})
		renameSessionInMessages(state.messages, oldId, threadId)
		this.aliases.set(oldId, threadId)
		this.liveSessions.delete(oldId)
		this.liveSessions.set(threadId, state)
		await this.syncRealSessionRecord(state, false)
		this.emitBackend(state.project, {
			type: "session.replaced",
			oldId,
			newId: threadId,
			directory: state.project.directory,
			workspaceId: state.project.workspaceId,
			session: state.session,
		})
	}

	handleAgentTextPart(state, item, phase) {
		this.ensureAssistantMessage(state)
		const messageId = state.currentAssistantMessageId
		const partId = `${messageId}:text:${item.id}`
		const existing = findPart(state.messages, messageId, partId)
		const next = makeTextPart(state.session.id, messageId, partId, item.text || "")
		upsertPart(state.messages, next)
		if (
			existing &&
			typeof existing.text === "string" &&
			typeof next.text === "string" &&
			next.text.startsWith(existing.text) &&
			next.text !== existing.text
		) {
			this.emitBackend(state.project, {
				type: "message.part.delta",
				sessionID: state.session.id,
				messageID: messageId,
				partID: partId,
				field: "text",
				delta: next.text.slice(existing.text.length),
			})
			if (phase === "completed") {
				this.emitBackend(state.project, { type: "message.part.updated", part: next })
			}
			return
		}
		this.emitBackend(state.project, { type: "message.part.updated", part: next })
	}

	handleReasoningPart(state, item, phase) {
		this.ensureAssistantMessage(state)
		const messageId = state.currentAssistantMessageId
		const partId = `${messageId}:reasoning:${item.id}`
		const existing = findPart(state.messages, messageId, partId)
		const next = {
			...(existing ?? makeReasoningPart(state.session.id, messageId, partId, item.text || "")),
			sessionID: state.session.id,
			messageID: messageId,
			text: item.text || "",
			time: {
				start: existing?.time?.start ?? Date.now(),
				...(phase === "completed" ? { end: Date.now() } : {}),
			},
		}
		upsertPart(state.messages, next)
		if (
			existing &&
			typeof existing.text === "string" &&
			next.text.startsWith(existing.text) &&
			next.text !== existing.text
		) {
			this.emitBackend(state.project, {
				type: "message.part.delta",
				sessionID: state.session.id,
				messageID: messageId,
				partID: partId,
				field: "text",
				delta: next.text.slice(existing.text.length),
			})
		}
		this.emitBackend(state.project, { type: "message.part.updated", part: next })
	}

	handleToolLikeItem(state, item, phase) {
		this.ensureAssistantMessage(state)
		const messageId = state.currentAssistantMessageId
		const partId = `${messageId}:tool:${item.id}`
		const existing = findPart(state.messages, messageId, partId)
		const next = buildToolPartFromItem(state.session.id, messageId, item, existing, phase)
		upsertPart(state.messages, next)
		this.emitBackend(state.project, { type: "message.part.updated", part: next })
	}

	finalizeAssistantMessage(state, usage) {
		if (!state.currentAssistantMessageId) return
		const bundle = findMessage(state.messages, state.currentAssistantMessageId)
		if (!bundle) return
		const info = {
			...bundle.info,
			time: {
				...bundle.info.time,
				completed: Date.now(),
			},
			tokens: {
				...bundle.info.tokens,
				input: usage?.input_tokens ?? bundle.info.tokens.input,
				output: usage?.output_tokens ?? bundle.info.tokens.output,
			},
		}
		bundle.info = info
		this.emitBackend(state.project, { type: "message.updated", message: info })
	}

	buildThreadOptions(project, model, variant) {
		return {
			model: resolveSelectedModelId(model),
			sandboxMode: "workspace-write",
			workingDirectory: project.directory,
			skipGitRepoCheck: false,
			modelReasoningEffort: resolveVariant(variant),
			approvalPolicy: "never",
		}
	}

	async stageImages(images) {
		const list = Array.isArray(images) ? images : []
		if (list.length === 0) return { inputImages: [], cleanup: async () => {} }
		const dir = await mkdtemp(join(tmpdir(), "opengui-codex-"))
		const paths = []
		try {
			for (let i = 0; i < list.length; i += 1) {
				const parsed = parseDataUrl(list[i])
				if (!parsed) continue
				const filePath = join(dir, `image-${i + 1}${mimeToExtension(parsed.mimeType)}`)
				await writeFile(filePath, Buffer.from(parsed.data, "base64"))
				paths.push(filePath)
			}
			return {
				inputImages: paths.map((path) => ({ type: "local_image", path })),
				cleanup: async () => {
					await rm(dir, { recursive: true, force: true })
				},
			}
		} catch (error) {
			await rm(dir, { recursive: true, force: true })
			throw error
		}
	}

	async runTurn(state, text, images, model, variant) {
		const controller = new AbortController()
		state.abortController = controller
		state.running = true
		state.currentAssistantMessageId = null
		state.currentModelId = resolveSelectedModelId(model)
		state.currentVariant = resolveVariant(variant)
		const threadOptions = this.buildThreadOptions(state.project, model, variant)
		const thread = state.threadId
			? this.codex.resumeThread(state.threadId, threadOptions)
			: this.codex.startThread(threadOptions)
		let inputImages = []
		let cleanup = async () => {}
		let emittedIdle = false
		let turnFailedMessage = null
		try {
			const staged = await this.stageImages(images)
			inputImages = staged.inputImages
			cleanup = staged.cleanup
			const input = [{ type: "text", text: String(text ?? "") }, ...inputImages]
			const streamed = await thread.runStreamed(input, { signal: controller.signal })
			for await (const event of streamed.events) {
				if (event.type === "thread.started") {
					await this.handleThreadStarted(state, event.thread_id)
					continue
				}
				if (event.type === "turn.started") {
					this.emitBackend(state.project, {
						type: "session.status",
						sessionID: state.session.id,
						status: sessionStatus("busy"),
					})
					continue
				}
				if (event.type === "turn.completed") {
					this.finalizeAssistantMessage(state, event.usage)
					await this.syncRealSessionRecord(state)
					this.emitBackend(state.project, {
						type: "session.status",
						sessionID: state.session.id,
						status: sessionStatus("idle"),
					})
					emittedIdle = true
					continue
				}
				if (event.type === "turn.failed") {
					turnFailedMessage = event.error?.message || "Codex turn failed"
					continue
				}
				if (event.type === "error") {
					turnFailedMessage = event.message || "Codex stream failed"
					continue
				}
				if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
					const phase = event.type === "item.completed" ? "completed" : "running"
					const item = event.item
					if (!item) continue
					if (item.type === "agent_message") {
						this.handleAgentTextPart(state, item, phase)
						continue
					}
					if (item.type === "reasoning") {
						this.handleReasoningPart(state, item, phase)
						continue
					}
					if (
						item.type === "command_execution" ||
						item.type === "file_change" ||
						item.type === "mcp_tool_call" ||
						item.type === "web_search" ||
						item.type === "todo_list"
					) {
						this.handleToolLikeItem(state, item, phase)
						continue
					}
					if (item.type === "error") {
						turnFailedMessage = item.message || "Codex item failed"
					}
				}
			}
			if (turnFailedMessage) {
				this.emitBackend(state.project, {
					type: "session.error",
					error: turnFailedMessage,
					sessionID: state.session.id,
				})
				await this.syncRealSessionRecord(state)
			}
		} catch (error) {
			if (!controller.signal.aborted) {
				this.emitBackend(state.project, {
					type: "session.error",
					error: error instanceof Error ? error.message : String(error),
					sessionID: state.session.id,
				})
				await this.syncRealSessionRecord(state)
			}
		} finally {
			state.running = false
			state.abortController = null
			state.currentAssistantMessageId = null
			if (!emittedIdle) {
				this.emitBackend(state.project, {
					type: "session.status",
					sessionID: state.session.id,
					status: sessionStatus("idle"),
				})
			}
			await cleanup()
			if (state.threadId) {
				await this.persistTranscript(state.threadId, state.messages)
			}
		}
	}

	async prompt(sessionId, text, images, model, _agent, variant, directory, workspaceId) {
		const state = await this.ensureLiveSessionForPrompt(
			sessionId,
			directory,
			workspaceId,
		)
		if (state.running) {
			throw new Error("Codex session already running")
		}
		this.appendSyntheticUserMessage(state, text, images, model, variant)
		if (state.threadId) {
			await this.persistTranscript(state.threadId, state.messages)
		}
		void this.runTurn(state, text, images, model, variant).catch((error) => {
			state.running = false
			state.abortController = null
			this.emitBackend(state.project, {
				type: "session.error",
				error: error instanceof Error ? error.message : String(error),
				sessionID: state.session.id,
			})
			this.emitBackend(state.project, {
				type: "session.status",
				sessionID: state.session.id,
				status: sessionStatus("idle"),
			})
		})
	}

	async abort(sessionId) {
		const state = this.getLiveSession(sessionId)
		state?.abortController?.abort()
		return true
	}

	async sendCommand(sessionId, command, args, model, agent, variant, directory, workspaceId) {
		const text = `/${command}${args ? ` ${args}` : ""}`
		await this.prompt(sessionId, text, [], model, agent, variant, directory, workspaceId)
	}

	async summarizeSession(sessionId, model, directory, workspaceId) {
		await this.prompt(sessionId, "/compact", [], model, undefined, undefined, directory, workspaceId)
	}

	async findFiles(directory, _workspaceId, query) {
		const cwd = normalizeDir(directory)
		if (!cwd) return []
		const q = String(query || "").trim().toLowerCase()
		if (!q) return []
		try {
			const { stdout } = await execFile("rg", ["--files"], {
				cwd,
				maxBuffer: 1024 * 1024 * 8,
			})
			return stdout
				.split(/\r?\n/)
				.filter(Boolean)
				.filter((file) => file.toLowerCase().includes(q))
				.slice(0, 200)
		} catch {
			return []
		}
	}
}

export function setupCodexBridge(ipcMain, getAllWindows) {
	const manager = new CodexBridgeManager(getAllWindows)

	ipcMain.handle("codex:project:add", async (_event, config) => {
		try {
			await manager.addProject(config)
			return ok(true)
		} catch (error) {
			return fail(error)
		}
	})

	ipcMain.handle("codex:project:remove", async (_event, directory, workspaceId) => {
		try {
			await manager.removeProject({ directory, workspaceId })
			return ok(true)
		} catch (error) {
			return fail(error)
		}
	})

	ipcMain.handle("codex:disconnect", async () => {
		try {
			manager.disconnect()
			return ok(true)
		} catch (error) {
			return fail(error)
		}
	})

	ipcMain.handle("codex:session:list", async (_event, directory, workspaceId) => {
		try {
			return ok(await manager.listSessions({ directory, workspaceId }))
		} catch (error) {
			return fail(error)
		}
	})

	ipcMain.handle("codex:session:create", async (_event, title, directory, workspaceId) => {
		try {
			return ok(await manager.createSession({ title, directory, workspaceId }))
		} catch (error) {
			return fail(error)
		}
	})

	ipcMain.handle("codex:session:delete", async (_event, sessionId, directory, workspaceId) => {
		try {
			return ok(await manager.deleteSession(sessionId, { directory, workspaceId }))
		} catch (error) {
			return fail(error)
		}
	})

	ipcMain.handle("codex:session:update", async (_event, sessionId, title, directory, workspaceId) => {
		try {
			return ok(await manager.updateSession(sessionId, title, { directory, workspaceId }))
		} catch (error) {
			return fail(error)
		}
	})

	ipcMain.handle("codex:session:statuses", async (_event, directory, workspaceId) => {
		try {
			return ok(await manager.getSessionStatuses({ directory, workspaceId }))
		} catch (error) {
			return fail(error)
		}
	})

	ipcMain.handle("codex:providers", async () => {
		try {
			return ok(await manager.getProviders())
		} catch (error) {
			return fail(error)
		}
	})

	ipcMain.handle("codex:agents", async () => {
		try {
			return ok(await manager.getAgents())
		} catch (error) {
			return fail(error)
		}
	})

	ipcMain.handle("codex:commands", async () => {
		try {
			return ok(await manager.getCommands())
		} catch (error) {
			return fail(error)
		}
	})

	ipcMain.handle("codex:messages", async (_event, sessionId, _options, directory, workspaceId) => {
		try {
			return ok(await manager.getMessages(sessionId, { directory, workspaceId }))
		} catch (error) {
			return fail(error)
		}
	})

	ipcMain.handle("codex:session:start", async (_event, input) => {
		try {
			return ok(await manager.startSession(input ?? {}))
		} catch (error) {
			return fail(error)
		}
	})

	ipcMain.handle("codex:prompt", async (_event, sessionId, text, images, model, agent, variant, directory, workspaceId) => {
		try {
			await manager.prompt(sessionId, text, images, model, agent, variant, directory, workspaceId)
			return ok(true)
		} catch (error) {
			return fail(error)
		}
	})

	ipcMain.handle("codex:abort", async (_event, sessionId) => {
		try {
			return ok(await manager.abort(sessionId))
		} catch (error) {
			return fail(error)
		}
	})

	ipcMain.handle("codex:command:send", async (_event, sessionId, command, args, model, agent, variant, directory, workspaceId) => {
		try {
			await manager.sendCommand(sessionId, command, args, model, agent, variant, directory, workspaceId)
			return ok(true)
		} catch (error) {
			return fail(error)
		}
	})

	ipcMain.handle("codex:session:summarize", async (_event, sessionId, model, directory, workspaceId) => {
		try {
			await manager.summarizeSession(sessionId, model, directory, workspaceId)
			return ok(true)
		} catch (error) {
			return fail(error)
		}
	})

	ipcMain.handle("codex:find:files", async (_event, directory, workspaceId, query) => {
		try {
			return ok(await manager.findFiles(directory, workspaceId, query))
		} catch (error) {
			return fail(error)
		}
	})
}
