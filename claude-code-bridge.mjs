/**
 * ESM bridge module loaded by main.cjs via dynamic import().
 * Hosts Claude Code Agent SDK project/session state and wires IPC handlers.
 */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, extname, join, normalize } from "node:path";
import { access, readFile, readdir } from "node:fs/promises";
import {
	deleteSession,
	forkSession,
	getSessionInfo,
	getSessionMessages,
	listSessions,
	query,
	renameSession,
} from "@anthropic-ai/claude-agent-sdk";

const require = createRequire(import.meta.url);

function isGlibcRuntime() {
	const report = process.report?.getReport?.();
	return Boolean(report?.header?.glibcVersionRuntime);
}

function resolveBundledClaudeExecutable() {
	const override = process.env.CLAUDE_CODE_EXECUTABLE?.trim();
	if (override) return override;
	const platform = process.platform;
	const arch = process.arch;
	const ext = platform === "win32" ? ".exe" : "";
	const candidates =
		platform === "linux"
			? isGlibcRuntime()
				? [
						`@anthropic-ai/claude-agent-sdk-linux-${arch}/claude${ext}`,
						`@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude${ext}`,
					]
				: [
						`@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude${ext}`,
						`@anthropic-ai/claude-agent-sdk-linux-${arch}/claude${ext}`,
					]
			: [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude${ext}`];
	for (const candidate of candidates) {
		try {
			return require.resolve(candidate);
		} catch {
			/* try next */
		}
	}
	return undefined;
}

const CLAUDE_EXECUTABLE_PATH = resolveBundledClaudeExecutable();

const DEFAULT_STATUS = {
	state: "idle",
	serverUrl: null,
	serverVersion: null,
	error: null,
	lastEventAt: null,
};

const MODEL_DISCOVERY_TTL_MS = 5 * 60 * 1000;
const EFFORT_VARIANTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const FALLBACK_SUPPORTED_MODELS = [
	{
		value: "default",
		displayName: "Sonnet",
		description: "Sonnet",
		supportsEffort: true,
		supportedEffortLevels: ["low", "medium", "high", "max"],
		supportsAdaptiveThinking: true,
	},
	{
		value: "opus",
		displayName: "Opus",
		description: "Opus",
		supportsEffort: true,
		supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
		supportsAdaptiveThinking: true,
	},
	{
		value: "haiku",
		displayName: "Haiku",
		description: "Haiku",
	},
];

const BUILTIN_COMMANDS = [
	{
		name: "compact",
		description: "Compact older session context",
		source: "command",
		template: "/compact",
		hints: [],
	},
	{
		name: "clear",
		description: "Clear current conversation state",
		source: "command",
		template: "/clear",
		hints: [],
	},
	{
		name: "help",
		description: "Show available slash commands",
		source: "command",
		template: "/help",
		hints: [],
	},
];

function makeModel(id, name, { reasoning, image, family, variants }) {
	return {
		id,
		providerID: "anthropic",
		api: {
			id,
			url: "https://api.anthropic.com",
			npm: "@anthropic-ai/claude-agent-sdk",
		},
		name,
		family: family ?? id,
		capabilities: {
			temperature: true,
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
		release_date: "",
		...(variants ? { variants } : {}),
	};
}

function makeClaudeEnv() {
	return {
		...process.env,
		CLAUDE_AGENT_SDK_CLIENT_APP: "OpenGUI",
	};
}

async function* holdOpenPrompt() {
	yield* [];
	await new Promise(() => {});
}

function firstDescriptionClause(description) {
	if (typeof description !== "string") return "";
	return description.split("·", 1)[0]?.trim() ?? "";
}

function deriveModelName(model) {
	const headline = firstDescriptionClause(model?.description);
	if (headline) return headline;
	if (model?.value === "default") return "Sonnet";
	if (typeof model?.displayName === "string" && model.displayName.trim()) {
		return model.displayName.trim();
	}
	return typeof model?.value === "string" && model.value.trim()
		? model.value.trim()
		: "Claude";
}

function deriveModelFamily(model) {
	const source = `${deriveModelName(model)} ${model?.displayName ?? ""}`.toLowerCase();
	if (source.includes("opus")) return "opus";
	if (source.includes("haiku")) return "haiku";
	if (source.includes("sonnet") || model?.value === "default") return "sonnet";
	return typeof model?.value === "string" && model.value.trim()
		? model.value.trim().toLowerCase()
		: "claude";
}

function buildModelVariants(model) {
	const variants = {};
	const supportsReasoning =
		Boolean(model?.supportsAdaptiveThinking) ||
		Boolean(model?.supportsEffort) ||
		Array.isArray(model?.supportedEffortLevels);
	if (!supportsReasoning) return undefined;
	variants.none = {};
	for (const level of model?.supportedEffortLevels ?? []) {
		if (EFFORT_VARIANTS.has(level)) variants[level] = {};
	}
	return Object.keys(variants).length > 0 ? variants : undefined;
}

function buildProvidersFromSupportedModels(models) {
	const normalizedModels = Array.isArray(models) && models.length > 0
		? models
		: FALLBACK_SUPPORTED_MODELS;
	const providerModels = Object.fromEntries(
		normalizedModels.map((model) => {
			const reasoning =
				Boolean(model?.supportsAdaptiveThinking) ||
				Boolean(model?.supportsEffort) ||
				Array.isArray(model?.supportedEffortLevels);
			return [
				model.value,
				makeModel(model.value, deriveModelName(model), {
					reasoning,
					image: false,
					family: deriveModelFamily(model),
					variants: buildModelVariants(model),
				}),
			];
		}),
	);
	const defaultModel =
		normalizedModels.find((model) => model?.value === "default")?.value ??
		normalizedModels[0]?.value ??
		"default";
	return {
		providers: [
			{
				id: "anthropic",
				name: "Anthropic",
				source: "api",
				env: ["ANTHROPIC_API_KEY"],
				options: {},
				models: providerModels,
			},
		],
		default: {
			anthropic: defaultModel,
		},
	};
}

function buildVariantQueryOptions(variant, modelInfo) {
	const normalized = typeof variant === "string" ? variant.trim().toLowerCase() : "";
	if (!normalized) return {};
	if (normalized === "none") {
		return { thinking: { type: "disabled" } };
	}
	if (!EFFORT_VARIANTS.has(normalized)) return {};
	const supportedLevels = Array.isArray(modelInfo?.supportedEffortLevels)
		? modelInfo.supportedEffortLevels
		: null;
	if (supportedLevels && !supportedLevels.includes(normalized)) return {};
	return {
		effort: normalized,
		...(modelInfo?.supportsAdaptiveThinking
			? { thinking: { type: "adaptive" } }
			: {}),
	};
}

function normalizeDir(directory) {
	if (typeof directory !== "string") return "";
	const trimmed = directory.trim();
	if (!trimmed) return "";
	return normalize(trimmed);
}

function makeProjectKey(workspaceId, directory) {
	return `${workspaceId ?? "local"}:${normalizeDir(directory)}`;
}

function nowConnection(status = {}) {
	return {
		...DEFAULT_STATUS,
		...status,
		lastEventAt: Date.now(),
	};
}

function ok(data) {
	return { success: true, data };
}

function fail(error, data) {
	return {
		success: false,
		error: error instanceof Error ? error.message : String(error),
		data,
	};
}

function makeSessionTitle(text, title) {
	const explicit = typeof title === "string" ? title.trim() : "";
	if (explicit) return explicit;
	const firstLine = String(text ?? "").trim().split(/\r?\n/, 1)[0] ?? "";
	return firstLine.slice(0, 80) || "Untitled";
}

function makeSessionFromInfo(info, target = {}, fallbackTitle) {
	const directory = normalizeDir(target.directory || info?.cwd || process.cwd());
	return {
		id: info?.sessionId,
		slug: info?.sessionId,
		projectID: directory,
		workspaceID: target.workspaceId,
		directory,
		title:
			info?.customTitle || info?.summary || info?.firstPrompt || fallbackTitle || "Untitled",
		version: "claude-code",
		time: {
			created: info?.createdAt ?? info?.lastModified ?? Date.now(),
			updated: info?.lastModified ?? info?.createdAt ?? Date.now(),
		},
	};
}

function defaultAssistantInfo(sessionId, messageId, directory, modelId = "default") {
	return {
		id: messageId,
		sessionID: sessionId,
		role: "assistant",
		time: { created: Date.now() },
		parentID: "",
		modelID: modelId,
		providerID: "anthropic",
		mode: "claude-code",
		agent: "claude",
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
	};
}

function defaultUserInfo(sessionId, messageId, modelId = "default", createdAt = Date.now()) {
	return {
		id: messageId,
		sessionID: sessionId,
		role: "user",
		time: { created: createdAt },
		agent: "claude",
		model: {
			providerID: "anthropic",
			modelID: modelId,
		},
	};
}

function mapClaudeModelId(raw) {
	if (typeof raw !== "string" || !raw.trim()) return "default";
	const value = raw.toLowerCase();
	if (value === "default" || value.includes("sonnet")) return "default";
	if (value.includes("opus")) return "opus";
	if (value.includes("haiku")) return "haiku";
	return raw;
}

function parseTimestamp(raw) {
	if (typeof raw !== "string") return Date.now();
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? parsed : Date.now();
}

function makeTextPart(sessionId, messageId, index, text, synthetic = false) {
	return {
		id: `${messageId}:text:${index}`,
		sessionID: sessionId,
		messageID: messageId,
		type: "text",
		text,
		synthetic,
		time: { start: Date.now() },
	};
}

function makeReasoningPart(sessionId, messageId, index, text) {
	return {
		id: `${messageId}:reasoning:${index}`,
		sessionID: sessionId,
		messageID: messageId,
		type: "reasoning",
		text,
		time: { start: Date.now() },
	};
}

function normalizeToolInput(_toolName, input = {}) {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return input ?? {};
	}
	const normalized = { ...input };
	if (typeof normalized.file_path === "string" && normalized.filePath === undefined) {
		normalized.filePath = normalized.file_path;
	}
	if (typeof normalized.old_string === "string" && normalized.oldString === undefined) {
		normalized.oldString = normalized.old_string;
	}
	if (typeof normalized.new_string === "string" && normalized.newString === undefined) {
		normalized.newString = normalized.new_string;
	}
	if (typeof normalized.task_description === "string" && normalized.description === undefined) {
		normalized.description = normalized.task_description;
	}
	if (typeof normalized.subagent_type === "string" && normalized.subagentType === undefined) {
		normalized.subagentType = normalized.subagent_type;
	}
	return normalized;
}

function makeToolPart(sessionId, messageId, index, toolName, input = {}, metadata = {}) {
	return {
		id: `${messageId}:tool:${index}`,
		sessionID: sessionId,
		messageID: messageId,
		type: "tool",
		callID: `${messageId}:call:${index}`,
		tool: toolName,
		state: {
			status: "completed",
			input: normalizeToolInput(toolName, input),
			output: "",
			title: toolName,
			metadata,
			time: {
				start: Date.now(),
				end: Date.now(),
			},
		},
	};
}

function getMessageBlocks(message) {
	const content = message?.message?.content;
	if (Array.isArray(content)) return content;
	return [content ?? message?.message].filter(Boolean);
}

function getToolResultBlocks(message) {
	const blocks = getMessageBlocks(message);
	if (blocks.length === 0) return [];
	const toolResults = blocks.filter(
		(block) => block && typeof block === "object" && block.type === "tool_result",
	);
	return toolResults.length === blocks.length ? toolResults : [];
}

function toolResultContentToText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) {
		if (content && typeof content === "object" && typeof content.text === "string") {
			return content.text;
		}
		return "";
	}
	const segments = [];
	for (const item of content) {
		if (typeof item === "string") {
			segments.push(item);
			continue;
		}
		if (!item || typeof item !== "object") continue;
		if (typeof item.text === "string") {
			segments.push(item.text);
			continue;
		}
		if (typeof item.content === "string") {
			segments.push(item.content);
		}
	}
	return segments.join("\n\n");
}

function mergeToolResultIntoPart(part, block) {
	const output = toolResultContentToText(block?.content);
	const metadata =
		part.state?.metadata && typeof part.state.metadata === "object"
			? part.state.metadata
			: {};
	return {
		...part,
		callID: block?.tool_use_id || part.callID,
		state: {
			...part.state,
			status: block?.is_error ? "error" : "completed",
			output: output || part.state.output || "",
			error: block?.is_error ? output || "Tool failed" : undefined,
			metadata: {
				...metadata,
				toolUseId: block?.tool_use_id || metadata.toolUseId,
			},
			time: {
				...part.state?.time,
				end: Date.now(),
			},
		},
	};
}

function contentToTextSegments(content) {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const result = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (typeof block.text === "string") {
			result.push(block.text);
			continue;
		}
		if (Array.isArray(block.content)) {
			for (const nested of block.content) {
				if (nested && typeof nested === "object" && typeof nested.text === "string") {
					result.push(nested.text);
				}
			}
		}
	}
	return result;
}

function mapUserHistoryMessage(message, sessionId) {
	const createdAt = parseTimestamp(message?.timestamp);
	const info = defaultUserInfo(sessionId, message.uuid, "sonnet", createdAt);
	const parts = contentToTextSegments(getMessageBlocks(message)).map((text, index) =>
		makeTextPart(sessionId, info.id, index, text),
	);
	return { info, parts };
}

function makeSyntheticUserMessage(sessionId, messageId, text, modelId = "sonnet") {
	const info = defaultUserInfo(sessionId, messageId, modelId, Date.now());
	const parts = String(text ?? "")
		.split(/\r?\n/)
		.flatMap((line, index, lines) => {
			if (line.length > 0) return [makeTextPart(sessionId, messageId, index, line)];
			return lines.length > 1
				? [makeTextPart(sessionId, messageId, index, " ", true)]
				: [];
		});
	return { info, parts };
}

function mapAssistantContent(sessionId, messageId, content) {
	if (!Array.isArray(content)) return [];
	const parts = [];
	for (let index = 0; index < content.length; index += 1) {
		const block = content[index];
		if (!block || typeof block !== "object") continue;
		if (typeof block.text === "string") {
			parts.push(makeTextPart(sessionId, messageId, index, block.text));
			continue;
		}
		if (typeof block.thinking === "string") {
			parts.push(makeReasoningPart(sessionId, messageId, index, block.thinking));
			continue;
		}
		if (block.type === "tool_use") {
			const part = makeToolPart(
				sessionId,
				messageId,
				index,
				block.name || "tool",
				block.input || {},
				{ id: block.id },
			);
			part.callID = block.id || part.callID;
			parts.push(part);
		}
	}
	return parts;
}

function mapAssistantHistoryMessage(message, sessionId, directory) {
	const createdAt = parseTimestamp(message?.timestamp);
	const modelID = mapClaudeModelId(message?.message?.model ?? message?.message?.modelId);
	const messageId = message?.message?.id || message.uuid;
	const info = {
		...defaultAssistantInfo(sessionId, messageId, directory, modelID),
		time: {
			created: createdAt,
			completed: createdAt,
		},
	};
	const parts = mapAssistantContent(sessionId, info.id, message?.message?.content);
	return { info, parts };
}

function mergeHistoryMessages(messages) {
	const merged = new Map();
	for (const entry of messages) {
		if (!entry) continue;
		const existing = merged.get(entry.info.id);
		if (!existing) {
			merged.set(entry.info.id, {
				info: entry.info,
				parts: [...entry.parts],
			});
			continue;
		}
		const partsById = new Map(existing.parts.map((part) => [part.id, part]));
		for (const part of entry.parts) {
			partsById.set(part.id, part);
		}
		merged.set(entry.info.id, {
			info: {
				...existing.info,
				...entry.info,
				time: {
					...existing.info.time,
					...entry.info.time,
					created: Math.min(
						existing.info.time?.created ?? entry.info.time?.created ?? Date.now(),
						entry.info.time?.created ?? existing.info.time?.created ?? Date.now(),
					),
					completed:
						entry.info.time?.completed ?? existing.info.time?.completed,
				},
			},
			parts: [...partsById.values()],
		});
	}
	return [...merged.values()];
}

function mapHistoryMessage(entry, target) {
	if (!entry || typeof entry !== "object" || !entry.uuid || !entry.session_id) {
		return null;
	}
	if (entry.type === "user") {
		if (getToolResultBlocks(entry).length > 0) return null;
		return mapUserHistoryMessage(entry, entry.session_id);
	}
	if (entry.type === "assistant") {
		return mapAssistantHistoryMessage(
			entry,
			entry.session_id,
			normalizeDir(target.directory || process.cwd()),
		);
	}
	return null;
}

function mapHistoryEntries(history, target) {
	const mapped = [];
	const toolRefs = new Map();
	for (const entry of history) {
		if (!entry || typeof entry !== "object" || !entry.uuid || !entry.session_id) {
			continue;
		}
		if (entry.type === "assistant") {
			const mappedEntry = mapHistoryMessage(entry, target);
			if (!mappedEntry) continue;
			mapped.push(mappedEntry);
			mappedEntry.parts.forEach((part, index) => {
				if (part?.type !== "tool") return;
				toolRefs.set(part.callID, { entry: mappedEntry, index });
				const metaId =
					part.state?.metadata && typeof part.state.metadata === "object"
						? part.state.metadata.id
						: undefined;
				if (typeof metaId === "string") {
					toolRefs.set(metaId, { entry: mappedEntry, index });
				}
			});
			continue;
		}
		if (entry.type === "user") {
			const toolResults = getToolResultBlocks(entry);
			if (toolResults.length > 0) {
				for (const block of toolResults) {
					const ref = toolRefs.get(block.tool_use_id);
					if (!ref) continue;
					const current = ref.entry.parts[ref.index];
					if (!current || current.type !== "tool") continue;
					ref.entry.parts[ref.index] = mergeToolResultIntoPart(current, block);
				}
				continue;
			}
			const mappedEntry = mapHistoryMessage(entry, target);
			if (mappedEntry) mapped.push(mappedEntry);
		}
	}
	return mergeHistoryMessages(mapped);
}

async function pathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function readCommandDescription(path) {
	try {
		const raw = await readFile(path, "utf8");
		const lines = raw.split(/\r?\n/);
		let inFrontmatter = false;
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			if (trimmed === "---") {
				inFrontmatter = !inFrontmatter;
				continue;
			}
			if (inFrontmatter) continue;
			return trimmed.replace(/^#+\s*/, "").slice(0, 120);
		}
	} catch {
		/* ignore */
	}
	return undefined;
}

async function scanCommandDirectory(baseDir) {
	const results = [];
	if (!baseDir || !(await pathExists(baseDir))) return results;
	const entries = await readdir(baseDir, { withFileTypes: true, recursive: true });
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (extname(entry.name).toLowerCase() !== ".md") continue;
		const fullPath = join(entry.parentPath, entry.name);
		const relativeName = basename(entry.name, extname(entry.name)).trim();
		if (!relativeName) continue;
		results.push({
			name: relativeName,
			description: await readCommandDescription(fullPath),
			source: "command",
			template: `/${relativeName} $ARGUMENTS`,
			hints: [],
		});
	}
	return results;
}

async function listClaudeCommands(directory) {
	const commands = [...BUILTIN_COMMANDS];
	const localCommands = await scanCommandDirectory(
		join(normalizeDir(directory), ".claude", "commands"),
	);
	const globalCommands = await scanCommandDirectory(
		join(homedir(), ".claude", "commands"),
	);
	const seen = new Set(commands.map((item) => item.name));
	for (const command of [...localCommands, ...globalCommands]) {
		if (seen.has(command.name)) continue;
		seen.add(command.name);
		commands.push(command);
	}
	return commands.sort((a, b) => a.name.localeCompare(b.name));
}

async function findFilesRecursive(directory, queryText, results, maxResults = 200) {
	if (!directory || results.length >= maxResults) return;
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (results.length >= maxResults) return;
		if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") {
			continue;
		}
		const fullPath = join(directory, entry.name);
		if (entry.isDirectory()) {
			await findFilesRecursive(fullPath, queryText, results, maxResults);
			continue;
		}
		if (fullPath.toLowerCase().includes(queryText)) results.push(fullPath);
	}
}

function sanitizePermissionUpdates(suggestions) {
	if (!Array.isArray(suggestions)) return [];
	const validDestinations = new Set([
		"userSettings",
		"projectSettings",
		"localSettings",
		"session",
		"cliArg",
	]);
	const validBehaviors = new Set(["allow", "deny", "ask"]);
	const validModes = new Set([
		"default",
		"acceptEdits",
		"bypassPermissions",
		"plan",
		"dontAsk",
		"auto",
	]);
	return suggestions.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		if (!validDestinations.has(item.destination)) return [];
		if (item.type === "setMode") {
			if (!validModes.has(item.mode)) return [];
			return [{ type: "setMode", mode: item.mode, destination: item.destination }];
		}
		if (item.type === "addDirectories" || item.type === "removeDirectories") {
			const directories = Array.isArray(item.directories)
				? item.directories.filter((value) => typeof value === "string" && value.trim())
				: [];
			if (directories.length === 0) return [];
			return [{ type: item.type, directories, destination: item.destination }];
		}
		if (
			item.type === "addRules" ||
			item.type === "replaceRules" ||
			item.type === "removeRules"
		) {
			if (!validBehaviors.has(item.behavior)) return [];
			const rules = Array.isArray(item.rules)
				? item.rules
						.filter((rule) => rule && typeof rule === "object" && typeof rule.toolName === "string")
						.map((rule) => ({
							toolName: rule.toolName,
							...(typeof rule.ruleContent === "string" ? { ruleContent: rule.ruleContent } : {}),
						}))
				: [];
			if (rules.length === 0) return [];
			return [{
				type: item.type,
				rules,
				behavior: item.behavior,
				destination: item.destination,
			}];
		}
		return [];
	});
}

class ClaudeCodeBridgeManager {
	constructor(emit) {
		this.emit = emit;
		this.projects = new Map();
		this.sessionTargets = new Map();
		this.activeQueries = new Map();
		this.providerCatalogs = new Map();
		this.providerCatalogPromises = new Map();
		// Maps tempSessionId → pending state for new sessions resolved before system/init
		this.pendingTempSessions = new Map();
	}

	cleanupPendingTempSession(tempSessionId) {
		if (!tempSessionId) return;
		this.pendingTempSessions.delete(tempSessionId);
		this.sessionTargets.delete(tempSessionId);
		this.activeQueries.delete(tempSessionId);
	}

	cleanupTargetCaches(directory, workspaceId) {
		for (const [sessionId, target] of this.sessionTargets.entries()) {
			if (target.directory === directory && target.workspaceId === workspaceId) {
				this.sessionTargets.delete(sessionId);
			}
		}
		for (const [tempSessionId, state] of this.pendingTempSessions.entries()) {
			if (
				state?.target?.directory === directory &&
				state?.target?.workspaceId === workspaceId
			) {
				this.pendingTempSessions.delete(tempSessionId);
			}
		}
		const key = makeProjectKey(workspaceId, directory);
		this.providerCatalogs.delete(key);
		this.providerCatalogPromises.delete(key);
	}

	emitConnectionStatus(target, status) {
		this.emit({
			type: "connection:status",
			directory: target.directory,
			workspaceId: target.workspaceId,
			payload: nowConnection(status),
		});
	}

	attachProject(config) {
		const directory = normalizeDir(config.directory);
		const target = { directory, workspaceId: config.workspaceId };
		const key = makeProjectKey(target.workspaceId, target.directory);
		this.projects.set(key, { ...config, directory });
		this.emitConnectionStatus(target, { state: "connected" });
	}

	removeProject(directory, workspaceId) {
		const normalized = normalizeDir(directory);
		const key = makeProjectKey(workspaceId, normalized);
		this.projects.delete(key);
		for (const [sessionId, entry] of this.activeQueries.entries()) {
			if (entry.directory !== normalized || entry.workspaceId !== workspaceId) continue;
			entry.query?.close?.();
			this.activeQueries.delete(sessionId);
		}
		this.cleanupTargetCaches(normalized, workspaceId);
		this.emitConnectionStatus(
			{ directory: normalized, workspaceId },
			{ state: "idle", error: null },
		);
	}

	disconnect() {
		for (const entry of this.activeQueries.values()) {
			entry.query?.close?.();
		}
		this.activeQueries.clear();
		this.sessionTargets.clear();
		this.pendingTempSessions.clear();
		this.providerCatalogs.clear();
		this.providerCatalogPromises.clear();
		for (const project of this.projects.values()) {
			this.emitConnectionStatus(
				{ directory: project.directory, workspaceId: project.workspaceId },
				{ state: "idle", error: null },
			);
			}
		this.projects.clear();
	}

	resolveTarget(directory, workspaceId, sessionId) {
		const normalized = normalizeDir(directory);
		if (normalized) return { directory: normalized, workspaceId };
		if (sessionId && this.sessionTargets.has(sessionId)) {
			return this.sessionTargets.get(sessionId);
		}
		const first = this.projects.values().next().value;
		return {
			directory: normalizeDir(first?.directory || process.cwd()),
			workspaceId: workspaceId ?? first?.workspaceId,
		};
	}

	getCachedProviderCatalog(directory, workspaceId, sessionId) {
		const target = this.resolveTarget(directory, workspaceId, sessionId);
		const key = makeProjectKey(target.workspaceId, target.directory);
		const cached = this.providerCatalogs.get(key);
		if (!cached) return null;
		if (Date.now() - cached.loadedAt > MODEL_DISCOVERY_TTL_MS) return null;
		return cached;
	}

	async discoverProviders(directory, workspaceId, sessionId) {
		const target = this.resolveTarget(directory, workspaceId, sessionId);
		const key = makeProjectKey(target.workspaceId, target.directory);
		const cached = this.getCachedProviderCatalog(directory, workspaceId, sessionId);
		if (cached) return cached;
		const inflight = this.providerCatalogPromises.get(key);
		if (inflight) return await inflight;

		const load = (async () => {
			try {
				const probe = query({
					prompt: holdOpenPrompt(),
					options: {
						cwd: target.directory,
						model: "haiku",
						pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE_PATH,
						settingSources: ["user", "project", "local"],
						managedSettings: { allowedMcpServers: [] },
						permissionMode: "acceptEdits",
						env: makeClaudeEnv(),
					},
				});
				try {
					const supportedModels = await probe.supportedModels();
					const catalog = {
						loadedAt: Date.now(),
						target,
						supportedModels,
						providers: buildProvidersFromSupportedModels(supportedModels),
					};
					this.providerCatalogs.set(key, catalog);
					return catalog;
				} finally {
					probe.close();
				}
			} catch {
				const catalog = {
					loadedAt: Date.now(),
					target,
					supportedModels: FALLBACK_SUPPORTED_MODELS,
					providers: buildProvidersFromSupportedModels(FALLBACK_SUPPORTED_MODELS),
				};
				this.providerCatalogs.set(key, catalog);
				return catalog;
			} finally {
				this.providerCatalogPromises.delete(key);
			}
		})();

		this.providerCatalogPromises.set(key, load);
		return await load;
	}

	lookupModelInfo(modelId, directory, workspaceId, sessionId) {
		if (typeof modelId !== "string" || !modelId.trim()) return null;
		const catalog = this.getCachedProviderCatalog(directory, workspaceId, sessionId);
		if (!catalog) return null;
		const raw = modelId.trim().toLowerCase();
		for (const model of catalog.supportedModels) {
			if (typeof model?.value === "string" && model.value.toLowerCase() === raw) {
				return model;
			}
		}
		for (const model of catalog.supportedModels) {
			const name = deriveModelName(model).toLowerCase();
			const family = deriveModelFamily(model).toLowerCase();
			if (raw === family || raw.includes(family) || (name && raw.includes(name))) {
				return model;
			}
		}
		return null;
	}

	async listSessions(directory, workspaceId) {
		const target = this.resolveTarget(directory, workspaceId);
		const sessions = await listSessions({ dir: target.directory, limit: 10_000 });
		return sessions.map((info) => {
			this.sessionTargets.set(info.sessionId, target);
			return makeSessionFromInfo(info, target);
		});
	}

	async getMessages(sessionId, options, directory, workspaceId) {
		const target = this.resolveTarget(directory, workspaceId, sessionId);
		this.sessionTargets.set(sessionId, target);

		// For pending temp sessions (created before system/init arrives), return
		// just the synthetic user message so the renderer has something to show
		// while the Claude Code subprocess is still initialising.
		const pendingTemp = this.pendingTempSessions.get(sessionId);
		if (pendingTemp) {
			const synthetic = makeSyntheticUserMessage(
				sessionId,
				pendingTemp.syntheticUserId,
				pendingTemp.promptText,
				mapClaudeModelId(pendingTemp.model?.modelID),
			);
			return { messages: [synthetic], nextCursor: null };
		}

		const history = await getSessionMessages(sessionId, {
			dir: target.directory,
			includeSystemMessages: false,
		});
		const mapped = mapHistoryEntries(history, target);
		const limit = Math.max(1, options?.limit ?? 100);
		const before = options?.before ?? null;
		if (mapped.length === 0) return { messages: [], nextCursor: null };
		let endIndex = mapped.length;
		if (before) {
			const foundIndex = mapped.findIndex((entry) => entry.info.id === before);
			endIndex = foundIndex >= 0 ? foundIndex : mapped.length;
		}
		const startIndex = Math.max(0, endIndex - limit);
		const page = mapped.slice(startIndex, endIndex);
		const nextCursor = startIndex > 0 ? page[0]?.info.id ?? null : null;
		return { messages: page, nextCursor };
	}

	listSessionStatuses(directory, workspaceId) {
		const target = this.resolveTarget(directory, workspaceId);
		const statuses = {};
		for (const [sessionId, entry] of this.activeQueries.entries()) {
			if (entry.directory !== target.directory) continue;
			if ((entry.workspaceId ?? undefined) !== (target.workspaceId ?? undefined)) {
				continue;
			}
			statuses[sessionId] = { type: "busy" };
		}
		return statuses;
	}

	async renameSession(sessionId, title, directory, workspaceId) {
		const target = this.resolveTarget(directory, workspaceId, sessionId);
		await renameSession(sessionId, title, { dir: target.directory });
		const info = await getSessionInfo(sessionId, { dir: target.directory });
		return makeSessionFromInfo(
			info ?? { sessionId, summary: title, lastModified: Date.now() },
			target,
			title,
		);
	}

	async deleteSession(sessionId, directory, workspaceId) {
		const target = this.resolveTarget(directory, workspaceId, sessionId);
		await deleteSession(sessionId, { dir: target.directory });
		if (this.activeQueries.has(sessionId)) {
			this.activeQueries.get(sessionId)?.query?.close?.();
			this.activeQueries.delete(sessionId);
		}
		this.cleanupPendingTempSession(sessionId);
		this.sessionTargets.delete(sessionId);
		this.emit({
			type: "claude-code:event",
			payload: {
				type: "session.deleted",
				directory: target.directory,
				workspaceId: target.workspaceId,
				sessionId,
			},
		});
		return true;
	}

	async forkSession(sessionId, messageID, directory, workspaceId) {
		const target = this.resolveTarget(directory, workspaceId, sessionId);
		const result = await forkSession(sessionId, {
			dir: target.directory,
			upToMessageId: messageID,
		});
		const info = await getSessionInfo(result.sessionId, { dir: target.directory });
		const session = makeSessionFromInfo(
			info ?? { sessionId: result.sessionId, summary: "Fork", lastModified: Date.now() },
			target,
			"Fork",
		);
		this.sessionTargets.set(result.sessionId, target);
		this.emit({
			type: "claude-code:event",
			payload: {
				type: "session.created",
				directory: target.directory,
				workspaceId: target.workspaceId,
				session,
			},
		});
		return session;
	}

	makePermissionHandler(targetRef) {
		return (toolName, input, context) =>
			new Promise((resolve) => {
				const target = targetRef();
				const sessionId = target.sessionId;
				const requestId = crypto.randomUUID();
				const normalizedInput =
					input && typeof input === "object" && !Array.isArray(input) ? input : {};
				const pending = {
					resolve,
					input: normalizedInput,
					suggestions: sanitizePermissionUpdates(context.suggestions),
					toolUseID: context.toolUseID,
				};
				if (!this.activeQueries.has(sessionId)) {
					resolve({
						behavior: "allow",
						updatedInput: normalizedInput,
						toolUseID: context.toolUseID,
					});
					return;
				}
				this.activeQueries.get(sessionId).pendingPermissions.set(requestId, pending);
				this.emit({
					type: "claude-code:event",
					payload: {
						type: "permission.requested",
						request: {
							id: requestId,
							sessionID: sessionId,
							permission:
								context.title || context.displayName || context.description || toolName,
							patterns: [context.blockedPath].filter(Boolean),
							metadata: {
								toolName,
								input: normalizedInput,
								description: context.description,
								decisionReason: context.decisionReason,
							},
							always: pending.suggestions.flatMap((item) =>
								Array.isArray(item.rules)
									? item.rules
											.map((rule) => rule?.ruleContent)
											.filter((value) => typeof value === "string")
									: [],
							),
						},
					},
				});
			});
	}

	emitSessionStatus(sessionId, type) {
		this.emit({
			type: "claude-code:event",
			payload: {
				type: "session.status",
				sessionID: sessionId,
				status: { type },
			},
		});
	}

	ensureActiveQuery(sessionId, queryHandle, target) {
		let entry = this.activeQueries.get(sessionId);
		if (!entry) {
			entry = {
				query: queryHandle,
				directory: target.directory,
				workspaceId: target.workspaceId,
				pendingPermissions: new Map(),
			};
			this.activeQueries.set(sessionId, entry);
		} else {
			entry.query = queryHandle;
		}
		this.sessionTargets.set(sessionId, target);
		return entry;
	}

	async refreshSessionInfo(sessionId, target, fallbackTitle) {
		try {
			const info = await getSessionInfo(sessionId, { dir: target.directory });
			if (!info) return;
			this.emit({
				type: "claude-code:event",
				payload: {
					type: "session.updated",
					directory: target.directory,
					workspaceId: target.workspaceId,
					session: makeSessionFromInfo(info, target, fallbackTitle),
				},
			});
		} catch {
			/* ignore */
		}
	}

	emitSyntheticUserMessage(state) {
		if (!state.sessionId || state.syntheticUserEmitted) return;
		const mapped = makeSyntheticUserMessage(
			state.sessionId,
			state.syntheticUserId,
			state.promptText,
			mapClaudeModelId(state.model?.modelID),
		);
		this.emit({
			type: "claude-code:event",
			payload: { type: "message.updated", message: mapped.info },
		});
		for (const part of mapped.parts) {
			this.emit({
				type: "claude-code:event",
				payload: { type: "message.part.updated", part },
			});
		}
		state.syntheticUserEmitted = true;
	}

	rememberToolPart(state, part) {
		if (!part || part.type !== "tool") return;
		state.toolParts.set(part.callID, part);
		const metaId =
			part.state?.metadata && typeof part.state.metadata === "object"
				? part.state.metadata.id
				: undefined;
		if (typeof metaId === "string") {
			state.toolParts.set(metaId, part);
		}
	}

	updateTrackedToolPart(state, toolUseId, updater) {
		const current = state.toolParts.get(toolUseId);
		if (!current || current.type !== "tool") return false;
		const nextPart = updater(current);
		state.toolParts.set(toolUseId, nextPart);
		this.rememberToolPart(state, nextPart);
		this.emit({
			type: "claude-code:event",
			payload: { type: "message.part.updated", part: nextPart },
		});
		return true;
	}

	enrichAssistantToolSnapshot(state, block) {
		if (!block || typeof block !== "object" || block.type !== "tool_use" || !block.id) {
			return;
		}
		this.updateTrackedToolPart(state, block.id, (current) => ({
			...current,
			callID: block.id || current.callID,
			tool: block.name || current.tool,
			state: {
				...current.state,
				input: normalizeToolInput(
					block.name || current.tool,
					block.input || current.state.input || {},
				),
				title: block.name || current.state.title,
				metadata: {
					...(current.state?.metadata && typeof current.state.metadata === "object"
						? current.state.metadata
						: {}),
					id: block.id,
				},
			},
		}));
	}

	applyToolResult(state, block) {
		if (!block?.tool_use_id) return false;
		return this.updateTrackedToolPart(state, block.tool_use_id, (current) =>
			mergeToolResultIntoPart(current, block),
		);
	}

	handleQueryMessage(message, state) {
		const sessionId = message?.session_id ?? state.sessionId;
		if (!sessionId) return;

		const prevTempId = state.tempSessionId;

		// If the real sessionId from the subprocess differs from our temp ID we
		// need to rename the session in the renderer before updating state.sessionId.
		if (prevTempId && sessionId !== prevTempId) {
			// Move the activeQueries entry from tempId → realId.
			const entry = this.activeQueries.get(prevTempId);
			if (entry) {
				this.activeQueries.delete(prevTempId);
				this.activeQueries.set(sessionId, entry);
			}
			// Remove the pending-temp tracking now that we have the real ID.
			this.pendingTempSessions.delete(prevTempId);
			state.tempSessionId = null;
		}

		state.sessionId = sessionId;
		this.ensureActiveQuery(sessionId, state.query, state.target);

		if (message.type === "system" && message.subtype === "init") {
			const realSession = {
				...makeSessionFromInfo(
					{
						sessionId,
						summary: state.fallbackTitle,
						lastModified: Date.now(),
						createdAt: Date.now(),
						cwd: state.target.directory,
					},
					state.target,
					state.fallbackTitle,
				),
				_syntheticUserId: state.syntheticUserId,
			};

			if (prevTempId && sessionId !== prevTempId) {
				// Tell the renderer to rename all state from tempId → realId.
				this.emit({
					type: "claude-code:event",
					payload: {
						type: "session.replaced",
						oldId: prevTempId,
						newId: sessionId,
						directory: state.target.directory,
						workspaceId: state.target.workspaceId,
						session: realSession,
					},
				});
			} else {
				// First-time init for an existing session (no temp ID) — emit normally.
				this.emit({
					type: "claude-code:event",
					payload: {
						type: "session.created",
						directory: state.target.directory,
						workspaceId: state.target.workspaceId,
						session: realSession,
					},
				});
				this.emitSyntheticUserMessage(state);
				this.emitSessionStatus(sessionId, "busy");
			}
			return;
		}

		if (message.type === "user") {
			const toolResults = getToolResultBlocks(message);
			if (toolResults.length > 0) {
				for (const block of toolResults) {
					this.applyToolResult(state, block);
				}
				return;
			}
			const userText = contentToTextSegments(getMessageBlocks(message)).join("\n\n").trim();
			if (state.syntheticUserEmitted && userText === String(state.promptText ?? "").trim()) {
				return;
			}
			state.syntheticUserEmitted = true;
			const mapped = mapUserHistoryMessage(message, sessionId);
			this.emit({
				type: "claude-code:event",
				payload: { type: "message.updated", message: mapped.info },
			});
			for (const part of mapped.parts) {
				this.emit({
					type: "claude-code:event",
					payload: { type: "message.part.updated", part },
				});
			}
			return;
		}

		if (!state.syntheticUserEmitted) {
			this.emitSyntheticUserMessage(state);
		}

		if (message.type === "stream_event") {
			const event = message.event;
			if (!event || typeof event !== "object") return;
			if (event.type === "message_start") {
				const messageId = event.message?.id;
				if (!messageId) return;
				state.currentAssistantMessageId = messageId;
				state.currentMessageParts.clear();
				const info = defaultAssistantInfo(
					sessionId,
					messageId,
					state.target.directory,
					mapClaudeModelId(event.message?.model),
				);
				this.emit({
					type: "claude-code:event",
					payload: { type: "message.updated", message: info },
				});
				return;
			}
			const messageId = state.currentAssistantMessageId;
			if (!messageId) return;
			if (event.type === "content_block_start") {
				const block = event.content_block;
				if (!block || typeof block !== "object") return;
				let part = null;
				if (block.type === "thinking" || block.type === "redacted_thinking") {
					part = makeReasoningPart(
						sessionId,
						messageId,
						event.index,
						block.thinking ?? block.text ?? "",
					);
				} else if (block.type === "tool_use") {
					part = {
						id: `${messageId}:tool:${event.index}`,
						sessionID: sessionId,
						messageID: messageId,
						type: "tool",
						callID: block.id || `${messageId}:call:${event.index}`,
						tool: block.name || "tool",
						state: {
							status: "running",
							input: normalizeToolInput(block.name || "tool", block.input || {}),
							output: "",
							title: block.name || "tool",
							metadata: { id: block.id },
							time: { start: Date.now() },
						},
					};
					this.rememberToolPart(state, part);
				} else {
					part = makeTextPart(sessionId, messageId, event.index, block.text ?? "");
				}
				state.currentMessageParts.set(part.id, part);
				this.emit({
					type: "claude-code:event",
					payload: { type: "message.part.updated", part },
				});
				return;
			}
			if (event.type === "content_block_delta") {
				const partId =
					event.delta?.type === "text_delta"
						? `${messageId}:text:${event.index}`
						: event.delta?.type === "thinking_delta"
							? `${messageId}:reasoning:${event.index}`
							: `${messageId}:tool:${event.index}`;
				const part = state.currentMessageParts.get(partId);
				if (!part) return;
				if (event.delta?.type === "text_delta") {
					this.emit({
						type: "claude-code:event",
						payload: {
							type: "message.part.delta",
							sessionID: sessionId,
							messageID: messageId,
							partID: part.id,
							field: "text",
							delta: event.delta.text,
						},
					});
					return;
				}
				if (event.delta?.type === "thinking_delta") {
					this.emit({
						type: "claude-code:event",
						payload: {
							type: "message.part.delta",
							sessionID: sessionId,
							messageID: messageId,
							partID: part.id,
							field: "text",
							delta: event.delta.thinking,
						},
					});
					return;
				}
				if (event.delta?.type === "input_json_delta" && part.type === "tool") {
					const nextPart = {
						...part,
						state: {
							...part.state,
							metadata: {
								...part.state.metadata,
								rawInput: `${part.state.metadata?.rawInput ?? ""}${event.delta.partial_json ?? ""}`,
							},
						},
					};
					state.currentMessageParts.set(part.id, nextPart);
					this.rememberToolPart(state, nextPart);
					this.emit({
						type: "claude-code:event",
						payload: { type: "message.part.updated", part: nextPart },
					});
				}
				return;
			}
			if (event.type === "message_stop") {
				state.currentAssistantMessageId = null;
				state.currentMessageParts.clear();
			}
			return;
		}

		if (message.type === "assistant") {
			const messageId = message.message?.id || state.currentAssistantMessageId || message.uuid;
			const info = {
				...defaultAssistantInfo(
					sessionId,
					messageId,
					state.target.directory,
					mapClaudeModelId(message.message?.model),
				),
				time: {
					created: Date.now(),
					completed: Date.now(),
				},
				error: message.error
					? {
						name: message.error,
						data: { message: message.error },
					}
					: undefined,
			};
			this.emit({
				type: "claude-code:event",
				payload: { type: "message.updated", message: info },
			});
			for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
				if (block?.type === "tool_use") {
					this.enrichAssistantToolSnapshot(state, block);
				}
			}
			const hasStreamedParts =
				state.currentAssistantMessageId === messageId && state.currentMessageParts.size > 0;
			if (!hasStreamedParts) {
				const parts = mapAssistantContent(sessionId, messageId, message.message?.content);
				for (const part of parts) {
					if (part.type === "tool") this.rememberToolPart(state, part);
					this.emit({
						type: "claude-code:event",
						payload: { type: "message.part.updated", part },
					});
				}
			}
			return;
		}

		if (message.type === "system" && message.subtype === "session_state_changed") {
			this.emitSessionStatus(sessionId, message.state === "idle" ? "idle" : "busy");
			return;
		}

		if (message.type === "auth_status" && message.error) {
			this.emit({
				type: "claude-code:event",
				payload: { type: "session.error", sessionID: sessionId, error: message.error },
			});
			return;
		}

		if (message.type === "result") {
			if (message.is_error && Array.isArray(message.errors) && message.errors.length > 0) {
				this.emit({
					type: "claude-code:event",
					payload: {
						type: "session.error",
						sessionID: sessionId,
						error: message.errors.join("\n"),
					},
				});
			}
			this.emitSessionStatus(sessionId, "idle");
			state.toolParts.clear();
			state.currentAssistantMessageId = null;
			state.currentMessageParts.clear();
		}
	}

	startQuery({ sessionId, text, title, directory, workspaceId, model, variant }) {
		const target = this.resolveTarget(directory, workspaceId, sessionId);
		const modelInfo = this.lookupModelInfo(
			model?.modelID,
			target.directory,
			target.workspaceId,
			sessionId,
		);
		let state;
		const targetRef = () => ({ sessionId: state?.sessionId, ...target });

		// For new sessions (no sessionId yet) pre-generate a temporary UUID so we
		// can emit session.created + the synthetic user message immediately, letting
		// the IPC call return right away instead of blocking for ~8 s until the
		// Claude Code subprocess sends its first system/init message.
		const tempSessionId = !sessionId ? crypto.randomUUID() : null;
		const effectiveSessionId = sessionId ?? tempSessionId;

		state = {
			sessionId: effectiveSessionId,
			// Remember the original tempId so we can emit session.replaced when
			// the real session_id arrives in system/init.
			tempSessionId,
			target,
			query: null,
			resolveSession: null,
			rejectSession: null,
			fallbackTitle: makeSessionTitle(text, title),
			promptText: text,
			model,
			variant,
			syntheticUserId: `synthetic-user:${crypto.randomUUID()}`,
			syntheticUserEmitted: false,
			currentAssistantMessageId: null,
			currentMessageParts: new Map(),
			toolParts: new Map(),
		};
		const options = {
			cwd: target.directory,
			resume: sessionId,
			model: model?.modelID,
			pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE_PATH,
			includePartialMessages: true,
			settingSources: ["user", "project", "local"],
			enableFileCheckpointing: true,
			// OpenGUI Claude Code backend does not expose MCP. Hard-disable MCP
			// servers in spawned SDK sessions to avoid startup stalls from
			// claude.ai connector handshakes before first system/init arrives.
			managedSettings: { allowedMcpServers: [] },
			tools: { type: "preset", preset: "claude_code" },
			disallowedTools: ["AskUserQuestion"],
			canUseTool: this.makePermissionHandler(targetRef),
			env: makeClaudeEnv(),
			...buildVariantQueryOptions(variant, modelInfo),
			...(sessionId ? {} : { title: state.fallbackTitle }),
		};
		const iterator = query({ prompt: text, options });
		state.query = iterator;

		// Always register, emit the synthetic user message, and mark session busy
		// immediately — both for new sessions (using the tempSessionId) and for
		// existing ones.  This makes the user's message appear in the UI right away
		// rather than waiting for the subprocess to start.
		this.ensureActiveQuery(effectiveSessionId, iterator, target);
		this.emitSyntheticUserMessage(state);
		this.emitSessionStatus(effectiveSessionId, "busy");

		let sessionPromise;
		if (tempSessionId) {
			// Emit session.created right now with the temp ID so the renderer can
			// display the session in the sidebar and load messages immediately.
			const tempSession = {
				...makeSessionFromInfo(
					{
						sessionId: tempSessionId,
						summary: state.fallbackTitle,
						lastModified: Date.now(),
						createdAt: Date.now(),
						cwd: target.directory,
					},
					target,
					state.fallbackTitle,
				),
				_syntheticUserId: state.syntheticUserId,
			};
			this.emit({
				type: "claude-code:event",
				payload: {
					type: "session.created",
					directory: target.directory,
					workspaceId: target.workspaceId,
					session: tempSession,
				},
			});
			// Store state so getMessages can return the synthetic message while
			// the subprocess is still initialising.
			this.pendingTempSessions.set(tempSessionId, state);
			// Resolve immediately — no need to wait for system/init.
			sessionPromise = Promise.resolve(tempSession);
		} else {
			// Existing session — nothing extra to do; caller doesn't await.
			sessionPromise = Promise.resolve(null);
		}

		void (async () => {
			try {
				for await (const message of iterator) {
					this.handleQueryMessage(message, state);
				}
				if (state.sessionId) {
					await this.refreshSessionInfo(state.sessionId, target, state.fallbackTitle);
					this.activeQueries.delete(state.sessionId);
				}
			} catch (error) {
				this.emit({
					type: "claude-code:event",
					payload: {
						type: "session.error",
						sessionID: state.sessionId,
						error: error instanceof Error ? error.message : String(error),
					},
				});
				this.emitSessionStatus(state.sessionId, "idle");
				this.activeQueries.delete(state.sessionId);
			} finally {
				this.cleanupPendingTempSession(state.tempSessionId);
			}
		})();
		return sessionPromise;
	}

	async startSession({ text, title, directory, workspaceId, model, variant }) {
		return await this.startQuery({
			text,
			title,
			directory,
			workspaceId,
			model,
			variant,
		});
	}

	async prompt(sessionId, text, _images, model, _agent, variant, directory, workspaceId) {
		void this.startQuery({
			sessionId,
			text,
			directory,
			workspaceId,
			model,
			variant,
		});
		return true;
	}

	async abort(sessionId) {
		const entry = this.activeQueries.get(sessionId);
		entry?.query?.close?.();
		this.activeQueries.delete(sessionId);
		this.cleanupPendingTempSession(sessionId);
		this.emitSessionStatus(sessionId, "idle");
		return true;
	}

	async respondPermission(sessionId, permissionId, response) {
		const entry = this.activeQueries.get(sessionId);
		const pending = entry?.pendingPermissions.get(permissionId);
		if (!pending) return true;
		entry.pendingPermissions.delete(permissionId);
		if (response === "reject") {
			pending.resolve({
				behavior: "deny",
				message: "Rejected by user",
				interrupt: true,
				toolUseID: pending.toolUseID,
			});
			return true;
		}
		pending.resolve({
			behavior: "allow",
			updatedInput: pending.input,
			toolUseID: pending.toolUseID,
			...(response === "always" && pending.suggestions.length > 0
				? { updatedPermissions: pending.suggestions }
				: {}),
		});
		return true;
	}

	async sendCommand(sessionId, command, args, model, _agent, variant, directory, workspaceId) {
		const text = `/${command}${args ? ` ${args}` : ""}`;
		await this.prompt(sessionId, text, [], model, undefined, variant, directory, workspaceId);
		return true;
	}

	async summarizeSession(sessionId, model, directory, workspaceId) {
		await this.sendCommand(sessionId, "compact", "", model, undefined, undefined, directory, workspaceId);
		return true;
	}

	async getProviders(directory, workspaceId) {
		const catalog = await this.discoverProviders(directory, workspaceId);
		return catalog.providers;
	}

	async getAgents() {
		return [];
	}

	async getCommands(directory, workspaceId) {
		const target = this.resolveTarget(directory, workspaceId);
		return await listClaudeCommands(target.directory);
	}

	async findFiles(directory, workspaceId, queryText) {
		const target = this.resolveTarget(directory, workspaceId);
		const results = [];
		await findFilesRecursive(
			target.directory,
			String(queryText ?? "").toLowerCase(),
			results,
		);
		return results;
	}
}

export function setupClaudeCodeBridge(ipcMain, _getWindows) {
	const listeners = new Map();
	const emit = (data) => {
		for (const [senderId, sender] of listeners) {
			if (sender.isDestroyed()) {
				listeners.delete(senderId);
				continue;
			}
			try {
				sender.send("claude-code:bridge-event", data);
			} catch {
				listeners.delete(senderId);
			}
		}
	};
	const manager = new ClaudeCodeBridgeManager(emit);

	ipcMain.on("claude-code:renderer-ready", (event) => {
		listeners.set(event.sender.id, event.sender);
		event.sender.once("destroyed", () => {
			listeners.delete(event.sender.id);
		});
	});

	ipcMain.handle("claude-code:project:add", async (_event, config) => {
		try {
			manager.attachProject(config ?? {});
			return ok(true);
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("claude-code:project:remove", async (_event, directory, workspaceId) => {
		try {
			manager.removeProject(directory, workspaceId);
			return ok(true);
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("claude-code:disconnect", async () => {
		try {
			manager.disconnect();
			return ok(true);
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("claude-code:session:list", async (_event, directory, workspaceId) => {
		try {
			return ok(await manager.listSessions(directory, workspaceId));
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("claude-code:session:delete", async (_event, sessionId, directory, workspaceId) => {
		try {
			return ok(await manager.deleteSession(sessionId, directory, workspaceId));
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("claude-code:session:update", async (_event, sessionId, title, directory, workspaceId) => {
		try {
			return ok(await manager.renameSession(sessionId, title, directory, workspaceId));
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("claude-code:session:statuses", async (_event, directory, workspaceId) => {
		try {
			return ok(manager.listSessionStatuses(directory, workspaceId));
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("claude-code:session:fork", async (_event, sessionId, messageID, directory, workspaceId) => {
		try {
			return ok(await manager.forkSession(sessionId, messageID, directory, workspaceId));
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("claude-code:providers", async (_event, directory, workspaceId) => {
		try {
			return ok(await manager.getProviders(directory, workspaceId));
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("claude-code:agents", async () => {
		try {
			return ok(await manager.getAgents());
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("claude-code:commands", async (_event, directory, workspaceId) => {
		try {
			return ok(await manager.getCommands(directory, workspaceId));
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("claude-code:messages", async (_event, sessionId, options, directory, workspaceId) => {
		try {
			return ok(await manager.getMessages(sessionId, options, directory, workspaceId));
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("claude-code:session:start", async (_event, input) => {
		try {
			return ok(await manager.startSession(input ?? {}));
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("claude-code:prompt", async (_event, sessionId, text, images, model, agent, variant, directory, workspaceId) => {
		try {
			await manager.prompt(sessionId, text, images, model, agent, variant, directory, workspaceId);
			return ok(true);
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("claude-code:abort", async (_event, sessionId) => {
		try {
			return ok(await manager.abort(sessionId));
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("claude-code:permission", async (_event, sessionId, permissionId, response) => {
		try {
			return ok(await manager.respondPermission(sessionId, permissionId, response));
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("claude-code:command:send", async (_event, sessionId, command, args, model, agent, variant, directory, workspaceId) => {
		try {
			return ok(await manager.sendCommand(sessionId, command, args, model, agent, variant, directory, workspaceId));
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("claude-code:session:summarize", async (_event, sessionId, model, directory, workspaceId) => {
		try {
			return ok(await manager.summarizeSession(sessionId, model, directory, workspaceId));
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("claude-code:find:files", async (_event, directory, workspaceId, queryText) => {
		try {
			return ok(await manager.findFiles(directory, workspaceId, queryText));
		} catch (error) {
			return fail(error);
		}
	});
}
