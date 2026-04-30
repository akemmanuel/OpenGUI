import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import {
	SessionManager,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
} from "@mariozechner/pi-coding-agent";


const execFile = promisify(execFileCallback);

const DEFAULT_STATUS = {
	state: "idle",
	serverUrl: null,
	serverVersion: null,
	error: null,
	lastEventAt: null,
};

const PROVIDER_ENVS = {
	anthropic: ["ANTHROPIC_API_KEY"],
	openai: ["OPENAI_API_KEY"],
	google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
	gemini: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
	xai: ["XAI_API_KEY"],
	groq: ["GROQ_API_KEY"],
	mistral: ["MISTRAL_API_KEY"],
	deepseek: ["DEEPSEEK_API_KEY"],
	cerebras: ["CEREBRAS_API_KEY"],
	moonshot: ["MOONSHOT_API_KEY"],
	ollama: [],
	lmstudio: [],
	bedrock: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
	azure: ["AZURE_OPENAI_API_KEY"],
};

const PI_THINKING_VARIANTS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const PI_DAEMON_STARTUP_TIMEOUT = 15_000;
const PI_DAEMON_SSE_RECONNECT_DELAY = 1_000;
const PI_DAEMON_HEALTH_TIMEOUT = 2_000;
// Bump when daemon import/runtime behavior changes. Existing healthy daemon gets reused
// across app restarts; failed lazy ESM imports inside pi-ai stay poisoned in-process.
const PI_DAEMON_VERSION = "2026-04-30-bun-pi-daemon-restart-v3";
const FRESH_PI_MODELS_TTL_MS = 60_000;
const __dirname = dirname(fileURLToPath(import.meta.url));
const freshPiModelsCache = new Map();

function normalizeDir(directory) {
	if (typeof directory !== "string") return "";
	const trimmed = directory.trim();
	return trimmed || "";
}

function makeProjectKey(workspaceId, directory) {
	return `${workspaceId ?? "local"}:${normalizeDir(directory)}`;
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

function nowConnection(status = {}) {
	return {
		...DEFAULT_STATUS,
		...status,
		lastEventAt: Date.now(),
	};
}

function coerceTimestamp(timestamp) {
	if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
	return Date.now();
}

function stringifyUnknown(value) {
	if (typeof value === "string") return value;
	if (value == null) return "";
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function makeSyntheticMessageId(sessionId, role, seq) {
	return `pi:${sessionId}:${role}:${seq}`;
}

function makeTextPartId(messageId, index) {
	return `${messageId}:text:${index}`;
}

function makeReasoningPartId(messageId, index) {
	return `${messageId}:reasoning:${index}`;
}

function makeFilePartId(messageId, index) {
	return `${messageId}:file:${index}`;
}

function makeToolPartId(messageId, toolCallId, index) {
	return `${messageId}:tool:${toolCallId || index}`;
}

function parseDataUrl(dataUrl) {
	if (typeof dataUrl !== "string") return null;
	const match = dataUrl.match(/^data:([^;,]+)?;base64,(.+)$/);
	if (!match) return null;
	return {
		mimeType: match[1] || "application/octet-stream",
		data: match[2],
	};
}

function piImageBlockToFilePart(block, messageId, index) {
	if (!block || block.type !== "image") return null;
	return {
		id: makeFilePartId(messageId, index),
		sessionID: "",
		messageID: messageId,
		type: "file",
		mime: block.mimeType || "application/octet-stream",
		filename: `image-${index + 1}.${(block.mimeType || "application/octet-stream").split("/")[1] || "bin"}`,
		url: `data:${block.mimeType || "application/octet-stream"};base64,${block.data}`,
	};
}

function toolResultContentToText(content) {
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (!block) continue;
		if (block.type === "text") {
			parts.push(block.text || "");
			continue;
		}
		if (block.type === "image") {
			parts.push(`[image ${block.mimeType || "application/octet-stream"}]`);
		}
	}
	return parts.join("\n").trim();
}

function makeSessionTitleFromText(text, title) {
	const explicit = typeof title === "string" ? title.trim() : "";
	if (explicit) return explicit;
	const firstLine = String(text ?? "").trim().split(/\r?\n/, 1)[0] ?? "";
	return firstLine.slice(0, 80) || "Untitled";
}

function normalizePiSession(info, target = {}) {
	const directory = normalizeDir(target.directory || info?.cwd || "");
	const rawFirstMessage =
		typeof info?.firstMessage === "string" ? info.firstMessage : stringifyUnknown(info?.firstMessage);
	const title = info?.name || rawFirstMessage || "Untitled";
	return {
		id: info.id,
		slug: info.id,
		projectID: directory,
		workspaceID: target.workspaceId,
		directory,
		title,
		version: "pi",
		time: {
			created: info.created?.getTime?.() ?? Date.now(),
			updated: info.modified?.getTime?.() ?? info.created?.getTime?.() ?? Date.now(),
		},
	};
}

function normalizePiModel(model) {
	const input = Array.isArray(model?.input) ? model.input : [];
	const variants = model?.reasoning
		? Object.fromEntries(
				PI_THINKING_VARIANTS.map((variant) => [variant, { label: variant }]),
			)
		: undefined;
	return {
		id: model.id,
		providerID: model.provider,
		api: {
			id: String(model.api || model.provider),
			url: model.baseUrl || "",
			npm: "@mariozechner/pi-coding-agent",
		},
		name: model.name || model.id,
		family: model.id,
		capabilities: {
			temperature: true,
			reasoning: Boolean(model.reasoning),
			attachment: input.includes("image"),
			toolcall: true,
			input: {
				text: true,
				audio: false,
				image: input.includes("image"),
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
			input: model.cost?.input ?? 0,
			output: model.cost?.output ?? 0,
			cache: {
				read: model.cost?.cacheRead ?? 0,
				write: model.cost?.cacheWrite ?? 0,
			},
		},
		limit: {
			context: model.contextWindow ?? 0,
			output: model.maxTokens ?? 0,
		},
		status: "active",
		options: {},
		headers: model.headers ?? {},
		release_date: "",
		variants,
	};
}

function parsePiTokenCount(value) {
	const text = String(value || "").trim().toUpperCase();
	if (!text) return 0;
	const match = text.match(/^(\d+(?:\.\d+)?)([KM])?$/);
	if (!match) return Number.parseInt(text.replace(/\D/g, ""), 10) || 0;
	const amount = Number.parseFloat(match[1]);
	const unit = match[2];
	if (unit === "M") return Math.round(amount * 1_000_000);
	if (unit === "K") return Math.round(amount * 1_000);
	return Math.round(amount);
}

function inferApiForProvider(provider, template) {
	if (template?.api) return template.api;
	if (provider.includes("anthropic")) return "anthropic-messages";
	if (provider.includes("google") || provider.includes("gemini")) return "google-generative-ai";
	if (provider.includes("codex")) return "openai-codex-responses";
	if (provider.includes("azure")) return "azure-openai-responses";
	if (provider.includes("openai")) return "openai-responses";
	return "openai-completions";
}

function inferBaseUrlForProvider(provider, template) {
	if (template?.baseUrl) return template.baseUrl;
	if (provider.includes("anthropic")) return "https://api.anthropic.com";
	if (provider.includes("google") || provider.includes("gemini")) return "https://generativelanguage.googleapis.com/v1beta";
	if (provider.includes("codex")) return "https://chatgpt.com/backend-api";
	if (provider.includes("openai")) return "https://api.openai.com";
	return "";
}

function parsePiListModelsTable(text, referenceModels = []) {
	const referencesByProvider = new Map();
	for (const model of referenceModels) {
		if (!referencesByProvider.has(model.provider)) referencesByProvider.set(model.provider, model);
	}
	const models = [];
	for (const rawLine of String(text || "").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("provider") || line.startsWith("─") || line.startsWith("-")) continue;
		const parts = line.split(/\s{2,}/).filter(Boolean);
		if (parts.length < 6) continue;
		const [provider, id, context, maxOut, thinking, images] = parts;
		if (!provider || !id || provider === "provider") continue;
		const template = referencesByProvider.get(provider);
		models.push({
			id,
			name: id,
			api: inferApiForProvider(provider, template),
			provider,
			baseUrl: inferBaseUrlForProvider(provider, template),
			reasoning: thinking === "yes",
			input: images === "yes" ? ["text", "image"] : ["text"],
			cost: template?.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: parsePiTokenCount(context),
			maxTokens: parsePiTokenCount(maxOut),
			headers: template?.headers || {},
			compat: template?.compat,
		});
	}
	return models;
}

function mergeModels(primaryModels, discoveredModels) {
	const byKey = new Map();
	for (const model of primaryModels) byKey.set(`${model.provider}/${model.id}`, model);
	for (const model of discoveredModels) byKey.set(`${model.provider}/${model.id}`, model);
	return Array.from(byKey.values());
}

function localPiCandidates() {
	const candidates = [];
	if (process.env.OPENGUI_PI_BINARY) candidates.push(process.env.OPENGUI_PI_BINARY);
	candidates.push(join(homedir(), ".bun", "bin", process.platform === "win32" ? "pi.cmd" : "pi"));
	candidates.push(join(homedir(), ".pi", "bin", process.platform === "win32" ? "pi.cmd" : "pi"));
	candidates.push("pi");
	return [...new Set(candidates)];
}

function localBunCandidates() {
	const candidates = [];
	if (process.env.OPENGUI_BUN_BINARY) candidates.push(process.env.OPENGUI_BUN_BINARY);
	if (process.env.BUN) candidates.push(process.env.BUN);
	candidates.push(join(homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun"));
	candidates.push("bun");
	return [...new Set(candidates)];
}

async function resolvePiListModelsCommand(binary) {
	const args = ["--list-models"];
	if (!binary.includes("/") && !binary.includes("\\")) {
		return { command: binary, args };
	}
	let resolved = binary;
	try {
		resolved = await realpath(binary);
	} catch {
		return { command: binary, args };
	}
	if (!resolved.endsWith(".js") && !resolved.endsWith(".mjs") && !resolved.endsWith(".cjs")) {
		return { command: binary, args };
	}
	for (const bun of localBunCandidates()) {
		try {
			return { command: bun, args: [resolved, ...args] };
		} catch {
			// Try next Bun candidate.
		}
		break;
	}
	return { command: binary, args };
}

async function discoverLocalPiModels(cwd, referenceModels = []) {
	const cacheKey = `${cwd || process.cwd()}:${referenceModels.length}`;
	const cached = freshPiModelsCache.get(cacheKey);
	if (cached && Date.now() - cached.time < FRESH_PI_MODELS_TTL_MS) return cached.models;
	let lastError = null;
	for (const binary of localPiCandidates()) {
		try {
			const pathParts = [
				join(homedir(), ".bun", "bin"),
				"/opt/homebrew/bin",
				"/usr/local/bin",
				"/usr/bin",
				"/bin",
				process.env.PATH || "",
			].filter(Boolean);
			const resolvedCommand = await resolvePiListModelsCommand(binary);
			if (process.env.OPENGUI_PI_DEBUG) {
				console.warn("Pi model discovery candidate:", binary, "->", resolvedCommand.command, resolvedCommand.args.join(" "));
			}
			const { stdout, stderr } = await execFile(resolvedCommand.command, resolvedCommand.args, {
				cwd: cwd || process.cwd(),
				env: {
					...process.env,
					PATH: [...new Set(pathParts.join(":").split(":"))].join(":"),
					PI_SKIP_VERSION_CHECK: "1",
					PI_OFFLINE: "1",
				},
				maxBuffer: 8 * 1024 * 1024,
				timeout: 15_000,
			});
			const models = parsePiListModelsTable(`${stdout}\n${stderr}`, referenceModels);
			if (process.env.OPENGUI_PI_DEBUG) {
				console.warn("Pi model discovery result:", binary, models.length);
			}
			if (models.length > 0) {
				freshPiModelsCache.set(cacheKey, { time: Date.now(), models });
				return models;
			}
		} catch (error) {
			if (process.env.OPENGUI_PI_DEBUG) {
				console.warn("Pi model discovery failed:", binary, error);
			}
			lastError = error;
		}
	}
	if (lastError && process.env.OPENGUI_PI_DEBUG) {
		console.warn("Failed to auto-discover local Pi models:", lastError);
	}
	freshPiModelsCache.set(cacheKey, { time: Date.now(), models: [] });
	return [];
}

function buildProvidersData(models) {
	const providers = new Map();
	const defaults = {};
	for (const model of models) {
		const providerId = model.provider;
		const normalizedModel = normalizePiModel(model);
		if (!providers.has(providerId)) {
			providers.set(providerId, {
				id: providerId,
				name: providerId,
				source: "api",
				env: PROVIDER_ENVS[providerId] ?? [],
				options: {},
				models: {},
			});
		}
		providers.get(providerId).models[normalizedModel.id] = normalizedModel;
		if (!defaults[providerId]) {
			defaults[providerId] = normalizedModel.id;
		}
	}
	return {
		providers: Array.from(providers.values()),
		default: defaults,
	};
}

function sessionStatus(type) {
	return { type };
}

function openGuiError(errorMessage) {
	return {
		name: "PiError",
		data: { message: errorMessage },
	};
}

function createUserInfo({ sessionId, messageId, timestamp, model, directory }) {
	return {
		id: messageId,
		sessionID: sessionId,
		role: "user",
		time: { created: timestamp },
		agent: "pi",
		model: {
			providerID: model?.provider ?? "pi",
			modelID: model?.modelId ?? "default",
		},
		system: directory || undefined,
	};
}

function createAssistantInfo({
	sessionId,
	messageId,
	timestamp,
	message,
	directory,
	parentID,
	createdAt,
	completedAt,
}) {
	return {
		id: messageId,
		sessionID: sessionId,
		role: "assistant",
		time: {
			created: typeof createdAt === "number" ? createdAt : timestamp,
			completed:
				message?.stopReason === "stop" ||
				message?.stopReason === "length" ||
				message?.stopReason === "toolUse" ||
				message?.stopReason === "error" ||
				message?.stopReason === "aborted"
					? (typeof completedAt === "number" ? completedAt : coerceTimestamp(message?.timestamp))
					: undefined,
		},
		error: message?.stopReason === "error" ? openGuiError(message?.errorMessage || "Pi error") : undefined,
		parentID: parentID || "",
		modelID: message?.model || "",
		providerID: message?.provider || "pi",
		mode: "pi",
		agent: "pi",
		path: {
			cwd: directory,
			root: directory,
		},
		cost: message?.usage?.cost?.total ?? 0,
		tokens: {
			total: message?.usage?.totalTokens,
			input: message?.usage?.input ?? 0,
			output: message?.usage?.output ?? 0,
			reasoning: 0,
			cache: {
				read: message?.usage?.cacheRead ?? 0,
				write: message?.usage?.cacheWrite ?? 0,
			},
		},
		finish: message?.stopReason,
	};
}

function visibleUiBranchEntries(sessionManager) {
	const branch = sessionManager.getBranch();
	let latestCompaction = null;
	for (const entry of branch) {
		if (entry.type === "compaction") latestCompaction = entry;
	}
	if (!latestCompaction) return branch;
	const compactionIdx = branch.findIndex((entry) => entry.id === latestCompaction.id);
	if (compactionIdx < 0) return branch;
	const visible = [];
	let foundFirstKept = false;
	for (let i = 0; i < compactionIdx; i++) {
		const entry = branch[i];
		if (entry.id === latestCompaction.firstKeptEntryId) {
			foundFirstKept = true;
		}
		if (foundFirstKept) visible.push(entry);
	}
	visible.push(latestCompaction);
	for (let i = compactionIdx + 1; i < branch.length; i++) {
		visible.push(branch[i]);
	}
	return visible;
}

function createBundle(info, parts = []) {
	return {
		info,
		parts,
	};
}

function cloneBundle(bundle) {
	return {
		info: { ...bundle.info },
		parts: bundle.parts.map((part) => ({ ...part })),
	};
}

function buildUserParts(content, messageId) {
	if (typeof content === "string") {
		return content
			? [
					{
						id: makeTextPartId(messageId, 0),
						sessionID: "",
						messageID: messageId,
						type: "text",
						text: content,
					},
				]
			: [];
	}
	const parts = [];
	let textIndex = 0;
	let fileIndex = 0;
	for (const block of Array.isArray(content) ? content : []) {
		if (!block) continue;
		if (block.type === "text") {
			parts.push({
				id: makeTextPartId(messageId, textIndex),
				sessionID: "",
				messageID: messageId,
				type: "text",
				text: block.text || "",
			});
			textIndex += 1;
			continue;
		}
		if (block.type === "image") {
			const filePart = piImageBlockToFilePart(block, messageId, fileIndex);
			if (filePart) parts.push(filePart);
			fileIndex += 1;
		}
	}
	return parts;
}

function normalizeToolInput(input = {}) {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return input ?? {};
	}
	const normalized = { ...input };
	if (typeof normalized.path === "string" && normalized.filePath === undefined) {
		normalized.filePath = normalized.path;
	}
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

function syncAssistantParts(bundle, message, reasoningTimesByContentIndex) {
	const existingToolPartsByCallId = new Map();
	for (const part of bundle.parts) {
		if (part.type === "tool") {
			existingToolPartsByCallId.set(part.callID, part);
		}
	}
	const nextParts = [];
	const content = Array.isArray(message?.content) ? message.content : [];
	let textIndex = 0;
	let reasoningIndex = 0;
	let toolIndex = 0;
	for (let contentIndex = 0; contentIndex < content.length; contentIndex += 1) {
		const block = content[contentIndex];
		if (!block) continue;
		if (block.type === "text") {
			nextParts.push({
				id: makeTextPartId(bundle.info.id, textIndex),
				sessionID: bundle.info.sessionID,
				messageID: bundle.info.id,
				type: "text",
				text: block.text || "",
			});
			textIndex += 1;
			continue;
		}
		if (block.type === "thinking") {
			const reasoningTime = reasoningTimesByContentIndex?.get(contentIndex);
			nextParts.push({
				id: makeReasoningPartId(bundle.info.id, reasoningIndex),
				sessionID: bundle.info.sessionID,
				messageID: bundle.info.id,
				type: "reasoning",
				text: block.thinking || (block.redacted ? "[Reasoning redacted]" : ""),
				time: {
					start: reasoningTime?.start ?? bundle.info.time.created,
					end:
						typeof reasoningTime?.end === "number"
							? reasoningTime.end
							: message?.stopReason
								? coerceTimestamp(message?.timestamp)
								: undefined,
				},
			});
			reasoningIndex += 1;
			continue;
		}
		if (block.type === "toolCall") {
			const existing = existingToolPartsByCallId.get(block.id);
			const normalizedInput = normalizeToolInput(block.arguments || {});
			nextParts.push({
				id: existing?.id ?? makeToolPartId(bundle.info.id, block.id, toolIndex),
				sessionID: bundle.info.sessionID,
				messageID: bundle.info.id,
				type: "tool",
				callID: block.id,
				tool: block.name,
				state:
					existing?.state ?? {
						status: "pending",
						input: normalizedInput,
						raw: stringifyUnknown(normalizedInput),
					},
			});
			toolIndex += 1;
		}
	}
	for (const existing of bundle.parts) {
		if (existing.type === "tool" && !nextParts.some((part) => part.id === existing.id)) {
			nextParts.push(existing);
		}
	}
	bundle.parts = nextParts;
}

function createSummaryUserBundle({ sessionId, messageId, timestamp, text, model, directory }) {
	return createBundle(
		createUserInfo({ sessionId, messageId, timestamp, model, directory }),
		text
			? [
					{
						id: makeTextPartId(messageId, 0),
						sessionID: sessionId,
						messageID: messageId,
						type: "text",
						text,
					},
				]
			: [],
	);
}

function createCompactionAssistantBundle({
	sessionId,
	messageId,
	timestamp,
	summary,
	model,
	directory,
	parentID,
	tailStartId,
}) {
	const info = {
		id: messageId,
		sessionID: sessionId,
		role: "assistant",
		time: { created: timestamp, completed: timestamp },
		parentID: parentID || "",
		modelID: model?.modelId ?? "",
		providerID: model?.provider ?? "pi",
		mode: "pi",
		agent: "pi",
		path: {
			cwd: directory,
			root: directory,
		},
		summary: true,
		cost: 0,
		tokens: {
			input: 0,
			output: 0,
			reasoning: 0,
			cache: { read: 0, write: 0 },
		},
		finish: "stop",
	};
	const parts = [];
	if (summary) {
		parts.push({
			id: makeTextPartId(messageId, 0),
			sessionID: sessionId,
			messageID: messageId,
			type: "text",
			text: summary,
		});
	}
	parts.push({
		id: `${messageId}:compaction`,
		sessionID: sessionId,
		messageID: messageId,
		type: "compaction",
		auto: false,
		tail_start_id: tailStartId,
	});
	return createBundle(info, parts);
}

function buildTranscriptFromSessionManager(sessionManager, directory) {
	const sessionId = sessionManager.getSessionId();
	const entries = visibleUiBranchEntries(sessionManager);
	const bundles = [];
	const toolPartByCallId = new Map();
	let lastUserMessageId = "";
	let currentModel = null;
	let lastTimelineTimestamp = null;

	for (const entry of entries) {
		if (entry.type === "model_change") {
			currentModel = { provider: entry.provider, modelId: entry.modelId };
			continue;
		}
		if (entry.type === "thinking_level_change" || entry.type === "label") {
			continue;
		}
		if (entry.type === "compaction") {
			const entryTimestamp = new Date(entry.timestamp).getTime();
			bundles.push(
				createCompactionAssistantBundle({
					sessionId,
					messageId: entry.id,
					timestamp: entryTimestamp,
					summary: entry.summary,
					model: currentModel,
					directory,
					parentID: lastUserMessageId,
					tailStartId: entry.firstKeptEntryId,
				}),
			);
			lastTimelineTimestamp = entryTimestamp;
			continue;
		}
		if (entry.type === "branch_summary") {
			const entryTimestamp = new Date(entry.timestamp).getTime();
			bundles.push(
				createSummaryUserBundle({
					sessionId,
					messageId: entry.id,
					timestamp: entryTimestamp,
					text: `[Branch summary]\n${entry.summary}`,
					model: currentModel,
					directory,
				}),
			);
			lastTimelineTimestamp = entryTimestamp;
			continue;
		}
		if (entry.type === "custom_message") {
			const entryTimestamp = new Date(entry.timestamp).getTime();
			const bundle = createBundle(
				createUserInfo({
					sessionId,
					messageId: entry.id,
					timestamp: entryTimestamp,
					model: currentModel,
					directory,
				}),
				buildUserParts(entry.content, entry.id),
			);
			for (const part of bundle.parts) {
				part.sessionID = sessionId;
			}
			bundles.push(bundle);
			lastTimelineTimestamp = entryTimestamp;
			continue;
		}
		if (entry.type !== "message") continue;

		const message = entry.message;
		if (message.role === "user") {
			const entryTimestamp = coerceTimestamp(message.timestamp);
			const bundle = createBundle(
				createUserInfo({
					sessionId,
					messageId: entry.id,
					timestamp: entryTimestamp,
					model: currentModel,
					directory,
				}),
				buildUserParts(message.content, entry.id),
			);
			for (const part of bundle.parts) {
				part.sessionID = sessionId;
			}
			bundles.push(bundle);
			lastUserMessageId = entry.id;
			lastTimelineTimestamp = entryTimestamp;
			continue;
		}

		if (message.role === "assistant") {
			currentModel = { provider: message.provider, modelId: message.model };
			const completedAt = coerceTimestamp(message.timestamp);
			const startedAt =
				typeof lastTimelineTimestamp === "number" ? lastTimelineTimestamp : completedAt;
			const bundle = createBundle(
				createAssistantInfo({
					sessionId,
					messageId: entry.id,
					timestamp: completedAt,
					message,
					directory,
					parentID: lastUserMessageId,
					createdAt: startedAt,
					completedAt,
				}),
				[],
			);
			syncAssistantParts(bundle, message);
			for (const part of bundle.parts) {
				part.sessionID = sessionId;
				if (part.type === "tool") {
					toolPartByCallId.set(part.callID, part);
				}
			}
			bundles.push(bundle);
			lastTimelineTimestamp = completedAt;
			continue;
		}

		if (message.role === "toolResult") {
			const toolResultTimestamp = coerceTimestamp(message.timestamp);
			const toolPart = toolPartByCallId.get(message.toolCallId);
			if (!toolPart) {
				lastTimelineTimestamp = toolResultTimestamp;
				continue;
			}
			const attachments = [];
			let imageIndex = 0;
			for (const block of Array.isArray(message.content) ? message.content : []) {
				if (block?.type === "image") {
					const filePart = piImageBlockToFilePart(
						block,
						toolPart.messageID,
						imageIndex,
					);
					if (filePart) {
						filePart.sessionID = sessionId;
						attachments.push(filePart);
					}
					imageIndex += 1;
				}
			}
			const fallbackStart =
				typeof lastTimelineTimestamp === "number"
					? lastTimelineTimestamp
					: toolResultTimestamp;
			toolPart.state = message.isError
				? {
					status: "error",
					input: toolPart.state.input,
					error: toolResultContentToText(message.content) || "Tool failed",
					time: {
						start: toolPart.state.time?.start ?? fallbackStart,
						end: toolResultTimestamp,
					},
				}
				: {
					status: "completed",
					input: toolPart.state.input,
					output: toolResultContentToText(message.content),
					title: toolPart.tool,
					metadata: message.details && typeof message.details === "object" ? message.details : {},
					time: {
						start: toolPart.state.time?.start ?? fallbackStart,
						end: toolResultTimestamp,
					},
					attachments: attachments.length > 0 ? attachments : undefined,
				};
			lastTimelineTimestamp = toolResultTimestamp;
		}
	}

	return {
		messages: bundles,
	};
}

export class PiBridgeManager {
	constructor(getAllWindows) {
		this.getAllWindows = getAllWindows;
		this.agentDir = getAgentDir();
		this.projects = new Map();
		this.projectInitPromises = new Map();
		this.sessionIndex = new Map();
	}

	sendNativeEvent(event) {
		for (const window of this.getAllWindows()) {
			if (window?.isDestroyed?.()) continue;
			window.webContents.send("pi:bridge-event", event);
		}
	}

	sendConnectionStatus(project, status) {
		this.sendNativeEvent({
			type: "connection:status",
			directory: project.directory,
			workspaceId: project.workspaceId,
			payload: status,
		});
	}

	sendBackendEvent(project, payload) {
		this.sendNativeEvent({
			type: "pi:event",
			directory: project.directory,
			workspaceId: project.workspaceId,
			payload,
		});
	}

	getProject(target = {}) {
		const directory = normalizeDir(target.directory);
		if (!directory) return null;
		return this.projects.get(makeProjectKey(target.workspaceId, directory)) || null;
	}

	getOrThrowProject(target = {}) {
		const project = this.getProject(target);
		if (!project) {
			throw new Error("Pi project not connected");
		}
		return project;
	}

	getLiveSessionContext(project, sessionId) {
		return project.liveSessionContexts.get(sessionId) || null;
	}

	syncProjectRuntime(project) {
		const firstContext = project.liveSessionContexts.values().next().value || null;
		project.runtime = firstContext?.runtime || null;
	}

	makeSyntheticState() {
		return {
			nextSeq: 0,
			currentUserMessageId: null,
			currentAssistantMessageId: null,
			assistantStartedAt: null,
			reasoningTimesByContentIndex: new Map(),
			syntheticToReal: new Map(),
		};
	}

	registerLiveSessionContext(project, runtime) {
		const session = runtime.session;
		const sessionId = session.sessionId;
		const existing = project.liveSessionContexts.get(sessionId);
		if (existing) {
			return existing;
		}
		const context = {
			runtime,
			session,
			unsubscribe: null,
		};
		project.liveSessionContexts.set(sessionId, context);
		project.sessionCaches.set(sessionId, buildTranscriptFromSessionManager(session.sessionManager, project.directory));
		project.syntheticStateBySessionId.set(sessionId, this.makeSyntheticState());
		if (session.sessionFile) {
			this.sessionIndex.set(sessionId, {
				projectKey: project.key,
				path: session.sessionFile,
				directory: project.directory,
				workspaceId: project.workspaceId,
			});
		}
		context.unsubscribe = session.subscribe((event) => {
			this.handleSessionEvent(project, session, event).catch((error) => {
				this.sendBackendEvent(project, {
					type: "session.error",
					error: error instanceof Error ? error.message : String(error),
					sessionID: session.sessionId,
				});
			});
		});
		this.syncProjectRuntime(project);
		return context;
	}

	async createRuntime(sessionManager) {
		const createRuntime = async ({ cwd, sessionManager, sessionStartEvent, agentDir }) => {
			const services = await createAgentSessionServices({ cwd, agentDir });
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		return createAgentSessionRuntime(createRuntime, {
			cwd: sessionManager.getCwd(),
			agentDir: this.agentDir,
			sessionManager,
		});
	}

	async ensureProject(target = {}) {
		const directory = normalizeDir(target.directory);
		if (!directory) {
			throw new Error("Directory required for Pi backend");
		}
		const workspaceId = target.workspaceId;
		const key = makeProjectKey(workspaceId, directory);
		const existingProject = this.projects.get(key);
		if (existingProject?.runtime || existingProject?.liveSessionContexts?.size > 0) {
			this.syncProjectRuntime(existingProject);
			this.sendConnectionStatus(existingProject, nowConnection({ state: "connected" }));
			return existingProject;
		}

		const pendingInit = this.projectInitPromises.get(key);
		if (pendingInit) return await pendingInit;

		if (existingProject && !(existingProject.runtime || existingProject.liveSessionContexts?.size > 0)) {
			this.projects.delete(key);
		}

		const project = {
			key,
			directory,
			workspaceId,
			busySessionIds: new Set(),
			sessionCaches: new Map(),
			syntheticStateBySessionId: new Map(),
			liveSessionContexts: new Map(),
			sessionContextInitPromises: new Map(),
			runtime: null,
			sessionUnsubscribe: null,
			currentSessionId: null,
			currentSessionFile: null,
		};
		const initPromise = (async () => {
			try {
				project.runtime = await this.createRuntime(SessionManager.continueRecent(directory));
				this.registerLiveSessionContext(project, project.runtime);
				this.projects.set(key, project);
				this.sendConnectionStatus(project, nowConnection({ state: "connected" }));
				return project;
			} catch (error) {
				this.projects.delete(key);
				throw error;
			} finally {
				this.projectInitPromises.delete(key);
			}
		})();
		this.projectInitPromises.set(key, initPromise);
		return await initPromise;
	}

	async createSessionContext(project, sessionManager) {
		const runtime = await this.createRuntime(sessionManager);
		return this.registerLiveSessionContext(project, runtime);
	}

	async ensureSessionContext(sessionId, target = {}) {
		const indexed = this.sessionIndex.get(sessionId);
		const project = indexed
			? await this.ensureProject({ directory: indexed.directory, workspaceId: indexed.workspaceId })
			: await this.ensureProject(target || {});
		const liveContext = this.getLiveSessionContext(project, sessionId);
		if (liveContext) {
			return { project, runtime: liveContext.runtime, session: liveContext.runtime.session, context: liveContext };
		}
		const pending = project.sessionContextInitPromises.get(sessionId);
		if (pending) return await pending;
		const initPromise = (async () => {
			let info = this.sessionIndex.get(sessionId);
			if (!info) {
				await this.listSessions({ directory: project.directory, workspaceId: project.workspaceId });
				info = this.sessionIndex.get(sessionId);
			}
			if (!info?.path) {
				throw new Error("Pi session not found");
			}
			const context = await this.createSessionContext(
				project,
				SessionManager.open(info.path, undefined, info.directory),
			);
			return { project, runtime: context.runtime, session: context.runtime.session, context };
		})();
		project.sessionContextInitPromises.set(sessionId, initPromise);
		try {
			return await initPromise;
		} finally {
			project.sessionContextInitPromises.delete(sessionId);
		}
	}

	async attachSession(project, session) {
		if (project.sessionUnsubscribe) {
			project.sessionUnsubscribe();
			project.sessionUnsubscribe = null;
		}
		project.currentSessionId = session.sessionId;
		project.currentSessionFile = session.sessionFile;
		const cache = buildTranscriptFromSessionManager(session.sessionManager, project.directory);
		project.sessionCaches.set(session.sessionId, cache);
		project.syntheticStateBySessionId.set(session.sessionId, {
			nextSeq: 0,
			currentUserMessageId: null,
			currentAssistantMessageId: null,
			assistantStartedAt: null,
			reasoningTimesByContentIndex: new Map(),
			syntheticToReal: new Map(),
		});
		if (session.sessionFile) {
			this.sessionIndex.set(session.sessionId, {
				projectKey: project.key,
				path: session.sessionFile,
				directory: project.directory,
				workspaceId: project.workspaceId,
			});
		}
		project.sessionUnsubscribe = session.subscribe((event) => {
			this.handleSessionEvent(project, session, event).catch((error) => {
				this.sendBackendEvent(project, {
					type: "session.error",
					error: error instanceof Error ? error.message : String(error),
					sessionID: session.sessionId,
				});
			});
		});
	}

	getSyntheticState(project, sessionId) {
		if (!project.syntheticStateBySessionId.has(sessionId)) {
			project.syntheticStateBySessionId.set(sessionId, this.makeSyntheticState());
		}
		return project.syntheticStateBySessionId.get(sessionId);
	}

	getSessionCache(project, sessionId) {
		if (!project.sessionCaches.has(sessionId)) {
			project.sessionCaches.set(sessionId, { messages: [] });
		}
		return project.sessionCaches.get(sessionId);
	}

	upsertBundle(project, sessionId, bundle) {
		const cache = this.getSessionCache(project, sessionId);
		const index = cache.messages.findIndex((item) => item.info.id === bundle.info.id);
		if (index >= 0) {
			cache.messages[index] = cloneBundle(bundle);
		} else {
			cache.messages.push(cloneBundle(bundle));
		}
	}

	findBundle(project, sessionId, messageId) {
		const cache = this.getSessionCache(project, sessionId);
		return cache.messages.find((item) => item.info.id === messageId) || null;
	}

	closeOpenReasoning(state, endedAt = Date.now(), exceptContentIndex = null) {
		for (const [contentIndex, time] of state.reasoningTimesByContentIndex) {
			if (contentIndex === exceptContentIndex) continue;
			if (!time || typeof time.start !== "number" || typeof time.end === "number") {
				continue;
			}
			time.end = endedAt;
		}
	}

	markReasoningStart(state, contentIndex, startedAt = Date.now()) {
		this.closeOpenReasoning(state, startedAt, contentIndex);
		const existing = state.reasoningTimesByContentIndex.get(contentIndex);
		state.reasoningTimesByContentIndex.set(contentIndex, {
			start:
				typeof existing?.start === "number"
					? existing.start
					: typeof state.assistantStartedAt === "number"
						? state.assistantStartedAt
						: startedAt,
			end: undefined,
		});
	}

	markReasoningEnd(state, contentIndex, endedAt = Date.now()) {
		const existing = state.reasoningTimesByContentIndex.get(contentIndex);
		state.reasoningTimesByContentIndex.set(contentIndex, {
			start:
				typeof existing?.start === "number"
					? existing.start
					: typeof state.assistantStartedAt === "number"
						? state.assistantStartedAt
						: endedAt,
			end: endedAt,
		});
		this.closeOpenReasoning(state, endedAt, contentIndex);
	}

	findRealEntryId(sessionManager, role, timestamp, contentText) {
		const branch = sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "message") continue;
			if (entry.message.role !== role) continue;
			const entryTime = coerceTimestamp(entry.message.timestamp ?? new Date(entry.timestamp).getTime());
			if (Math.abs(entryTime - timestamp) > 4000) continue;
			if (role === "user") {
				const text = typeof entry.message.content === "string"
					? entry.message.content
					: Array.isArray(entry.message.content)
						? entry.message.content.filter((part) => part.type === "text").map((part) => part.text || "").join("\n")
						: "";
				if (contentText && text !== contentText) continue;
			}
			return entry.id;
		}
		return null;
	}

	queueSyntheticResolution(project, session, role, syntheticId, timestamp, contentText) {
		setTimeout(() => {
			try {
				const realId = this.findRealEntryId(session.sessionManager, role, timestamp, contentText);
				if (!realId) return;
				const state = this.getSyntheticState(project, session.sessionId);
				state.syntheticToReal.set(syntheticId, realId);
			} catch {
				/* ignore */
			}
		}, 0);
	}

	async handleSessionEvent(project, session, event) {
		const sessionId = session.sessionId;
		const state = this.getSyntheticState(project, sessionId);
		if (event.type === "agent_start") {
			project.busySessionIds.add(sessionId);
			this.sendBackendEvent(project, {
				type: "session.status",
				sessionID: sessionId,
				status: sessionStatus("busy"),
			});
			return;
		}

		if (event.type === "compaction_end") {
			if (event.result) {
				project.sessionCaches.set(
					sessionId,
					buildTranscriptFromSessionManager(session.sessionManager, project.directory),
				);
			}
			return;
		}

		if (event.type === "agent_end") {
			project.busySessionIds.delete(sessionId);
			const normalized = await this.getSessionById(sessionId, {
				directory: project.directory,
				workspaceId: project.workspaceId,
			});
			if (normalized) {
				this.sendBackendEvent(project, {
					type: "session.updated",
					directory: project.directory,
					workspaceId: project.workspaceId,
					session: normalized,
				});
			}
			this.sendBackendEvent(project, {
				type: "session.status",
				sessionID: sessionId,
				status: sessionStatus("idle"),
			});
			return;
		}

		if (event.type === "message_start") {
			if (event.message.role === "user") {
				const messageId = makeSyntheticMessageId(sessionId, "user", state.nextSeq++);
				state.currentUserMessageId = messageId;
				const bundle = createBundle(
					createUserInfo({
						sessionId,
						messageId,
						timestamp: coerceTimestamp(event.message.timestamp),
						model: session.sessionManager.buildSessionContext().model,
						directory: project.directory,
					}),
					buildUserParts(event.message.content, messageId),
				);
				for (const part of bundle.parts) part.sessionID = sessionId;
				this.upsertBundle(project, sessionId, bundle);
				this.sendBackendEvent(project, { type: "message.updated", message: bundle.info });
				for (const part of bundle.parts) {
					this.sendBackendEvent(project, { type: "message.part.updated", part });
				}
				return;
			}
			if (event.message.role === "assistant") {
				const messageId = makeSyntheticMessageId(sessionId, "assistant", state.nextSeq++);
				const startedAt = Date.now();
				state.currentAssistantMessageId = messageId;
				state.assistantStartedAt = startedAt;
				state.reasoningTimesByContentIndex = new Map();
				const bundle = createBundle(
					createAssistantInfo({
						sessionId,
						messageId,
						timestamp: coerceTimestamp(event.message.timestamp),
						message: event.message,
						directory: project.directory,
						parentID: state.currentUserMessageId || "",
						createdAt: startedAt,
					}),
					[],
				);
				syncAssistantParts(bundle, event.message, state.reasoningTimesByContentIndex);
				this.upsertBundle(project, sessionId, bundle);
				this.sendBackendEvent(project, { type: "message.updated", message: bundle.info });
				for (const part of bundle.parts) {
					this.sendBackendEvent(project, { type: "message.part.updated", part });
				}
				return;
			}
			return;
		}

		if (event.type === "message_update" && event.message.role === "assistant") {
			const messageId = state.currentAssistantMessageId;
			if (!messageId) return;
			const eventAt = Date.now();
			if (event.assistantMessageEvent.type === "thinking_start") {
				this.markReasoningStart(state, event.assistantMessageEvent.contentIndex, eventAt);
			} else if (event.assistantMessageEvent.type === "thinking_delta") {
				if (!state.reasoningTimesByContentIndex.has(event.assistantMessageEvent.contentIndex)) {
					this.markReasoningStart(state, event.assistantMessageEvent.contentIndex, eventAt);
				}
			} else if (event.assistantMessageEvent.type === "thinking_end") {
				this.markReasoningEnd(state, event.assistantMessageEvent.contentIndex, eventAt);
			} else if (
				event.assistantMessageEvent.type === "text_start" ||
				event.assistantMessageEvent.type === "toolcall_start"
			) {
				this.closeOpenReasoning(state, eventAt);
			}
			const bundle = this.findBundle(project, sessionId, messageId);
			if (!bundle) return;
			bundle.info = createAssistantInfo({
				sessionId,
				messageId,
				timestamp: coerceTimestamp(event.message.timestamp),
				message: event.message,
				directory: project.directory,
				parentID: bundle.info.parentID,
				createdAt: bundle.info.time.created,
			});
			syncAssistantParts(bundle, event.message, state.reasoningTimesByContentIndex);
			this.upsertBundle(project, sessionId, bundle);
			this.sendBackendEvent(project, { type: "message.updated", message: bundle.info });
			for (const part of bundle.parts) {
				this.sendBackendEvent(project, { type: "message.part.updated", part });
			}
			return;
		}

		if (event.type === "tool_execution_start") {
			const messageId = state.currentAssistantMessageId;
			if (!messageId) return;
			const bundle = this.findBundle(project, sessionId, messageId);
			if (!bundle) return;
			const normalizedInput = normalizeToolInput(event.args || {});
			let part = bundle.parts.find(
				(item) => item.type === "tool" && item.callID === event.toolCallId,
			);
			if (!part) {
				part = {
					id: makeToolPartId(messageId, event.toolCallId, bundle.parts.length),
					sessionID: sessionId,
					messageID: messageId,
					type: "tool",
					callID: event.toolCallId,
					tool: event.toolName,
					state: {
						status: "pending",
						input: normalizedInput,
						raw: stringifyUnknown(normalizedInput),
					},
				};
				bundle.parts.push(part);
			}
			part.state = {
				status: "running",
				input: normalizedInput,
				title: event.toolName,
				time: { start: Date.now() },
			};
			this.upsertBundle(project, sessionId, bundle);
			this.sendBackendEvent(project, { type: "message.part.updated", part });
			return;
		}

		if (event.type === "tool_execution_update") {
			const messageId = state.currentAssistantMessageId;
			if (!messageId) return;
			const bundle = this.findBundle(project, sessionId, messageId);
			if (!bundle) return;
			const part = bundle.parts.find(
				(item) => item.type === "tool" && item.callID === event.toolCallId,
			);
			if (!part) return;
			part.state = {
				status: "running",
				input: normalizeToolInput(event.args || {}),
				title: event.toolName,
				metadata:
					event.partialResult?.details && typeof event.partialResult.details === "object"
						? event.partialResult.details
						: {},
				time: {
					start: part.state.time?.start ?? Date.now(),
				},
			};
			this.upsertBundle(project, sessionId, bundle);
			this.sendBackendEvent(project, { type: "message.part.updated", part });
			return;
		}

		if (event.type === "tool_execution_end") {
			const messageId = state.currentAssistantMessageId;
			if (!messageId) return;
			const bundle = this.findBundle(project, sessionId, messageId);
			if (!bundle) return;
			const part = bundle.parts.find(
				(item) => item.type === "tool" && item.callID === event.toolCallId,
			);
			if (!part) return;
			part.state = event.isError
				? {
					status: "error",
					input: part.state.input || {},
					error:
						event.result?.content ? toolResultContentToText(event.result.content) : stringifyUnknown(event.result?.details) || "Tool failed",
					time: {
						start: part.state.time?.start ?? Date.now(),
						end: Date.now(),
					},
				}
				: {
					status: "completed",
					input: part.state.input || {},
					output:
						event.result?.content ? toolResultContentToText(event.result.content) : stringifyUnknown(event.result?.details),
					title: event.toolName,
					metadata:
						event.result?.details && typeof event.result.details === "object" ? event.result.details : {},
					time: {
						start: part.state.time?.start ?? Date.now(),
						end: Date.now(),
					},
				};
			this.upsertBundle(project, sessionId, bundle);
			this.sendBackendEvent(project, { type: "message.part.updated", part });
			return;
		}

		if (event.type === "message_end") {
			if (event.message.role === "user") {
				const messageId = state.currentUserMessageId;
				if (!messageId) return;
				const bundle = this.findBundle(project, sessionId, messageId);
				if (!bundle) return;
				this.queueSyntheticResolution(
					project,
					session,
					"user",
					messageId,
					coerceTimestamp(event.message.timestamp),
					typeof event.message.content === "string"
						? event.message.content
						: Array.isArray(event.message.content)
							? event.message.content.filter((part) => part.type === "text").map((part) => part.text || "").join("\n")
							: "",
				);
				return;
			}
			if (event.message.role === "assistant") {
				const messageId = state.currentAssistantMessageId;
				if (!messageId) return;
				const completedAt = Date.now();
				this.closeOpenReasoning(state, completedAt);
				const bundle = this.findBundle(project, sessionId, messageId);
				if (!bundle) return;
				bundle.info = createAssistantInfo({
					sessionId,
					messageId,
					timestamp: coerceTimestamp(event.message.timestamp),
					message: event.message,
					directory: project.directory,
					parentID: bundle.info.parentID,
					createdAt: bundle.info.time.created,
					completedAt,
				});
				syncAssistantParts(bundle, event.message, state.reasoningTimesByContentIndex);
				this.upsertBundle(project, sessionId, bundle);
				this.sendBackendEvent(project, { type: "message.updated", message: bundle.info });
				for (const part of bundle.parts) {
					this.sendBackendEvent(project, { type: "message.part.updated", part });
				}
				if (event.message.stopReason === "error" && event.message.errorMessage) {
					this.sendBackendEvent(project, {
						type: "session.error",
						error: event.message.errorMessage,
						sessionID: sessionId,
					});
				}
				this.queueSyntheticResolution(project, session, "assistant", messageId, coerceTimestamp(event.message.timestamp), "");
				state.assistantStartedAt = null;
				state.reasoningTimesByContentIndex = new Map();
				return;
			}
		}
	}

	async listSessions(target) {
		if (target?.directory) {
			const project = await this.ensureProject(target);
			const infos = await SessionManager.list(project.directory);
			for (const info of infos) {
				this.sessionIndex.set(info.id, {
					projectKey: project.key,
					path: info.path,
					directory: project.directory,
					workspaceId: project.workspaceId,
				});
			}
			return infos.map((info) => normalizePiSession(info, project));
		}
		const sessions = [];
		for (const project of this.projects.values()) {
			const infos = await SessionManager.list(project.directory);
			for (const info of infos) {
				this.sessionIndex.set(info.id, {
					projectKey: project.key,
					path: info.path,
					directory: project.directory,
					workspaceId: project.workspaceId,
				});
				sessions.push(normalizePiSession(info, project));
			}
		}
		return sessions.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
	}

	async getSessionById(sessionId, target) {
		const project = target?.directory ? await this.ensureProject(target) : null;
		const indexed = this.sessionIndex.get(sessionId);
		if (indexed?.path) {
			const manager = SessionManager.open(indexed.path, undefined, indexed.directory);
			const firstUserEntry = manager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "user");
			return normalizePiSession(
				{
					id: sessionId,
					cwd: indexed.directory,
					name: manager.getSessionName(),
					created: new Date(manager.getHeader().timestamp),
					modified: new Date(),
					firstMessage:
						firstUserEntry?.type === "message"
							? typeof firstUserEntry.message.content === "string"
								? firstUserEntry.message.content
								: Array.isArray(firstUserEntry.message.content)
									? firstUserEntry.message.content
										.filter((part) => part.type === "text")
										.map((part) => part.text || "")
										.join("\n")
									: ""
							: "",
				},
				{
					directory: indexed.directory,
					workspaceId: indexed.workspaceId,
				},
			);
		}
		if (!project) return null;
		const sessions = await this.listSessions({
			directory: project.directory,
			workspaceId: project.workspaceId,
		});
		return sessions.find((session) => session.id === sessionId) || null;
	}

	// legacy project-level session switch removed
	resolveRealMessageId(project, sessionId, messageId) {
		const state = this.getSyntheticState(project, sessionId);
		return state.syntheticToReal.get(messageId) || messageId;
	}

	async addProject(config) {
		await this.ensureProject(config);
	}

	async removeProject(target) {
		const directory = normalizeDir(target?.directory);
		const key = directory ? makeProjectKey(target?.workspaceId, directory) : null;
		const pendingInit = key ? this.projectInitPromises.get(key) : null;
		if (pendingInit) {
			try {
				await pendingInit;
			} catch {
				return;
			}
		}
		const project = this.getProject(target);
		if (!project) return;
		await Promise.allSettled(project.sessionContextInitPromises.values());
		for (const context of project.liveSessionContexts.values()) {
			context.unsubscribe?.();
		}
		await Promise.allSettled([...project.liveSessionContexts.values()].map((context) => context.runtime.dispose()));
		project.liveSessionContexts.clear();
		project.sessionCaches.clear();
		project.syntheticStateBySessionId.clear();
		project.sessionContextInitPromises.clear();
		project.runtime = null;
		project.sessionUnsubscribe = null;
		for (const [sessionId, info] of this.sessionIndex.entries()) {
			if (info.projectKey === project.key) {
				this.sessionIndex.delete(sessionId);
			}
		}
		this.projects.delete(project.key);
		this.sendConnectionStatus(project, nowConnection({ state: "idle" }));
	}

	async disconnect() {
		await Promise.allSettled(this.projectInitPromises.values());
		const projects = Array.from(this.projects.values());
		for (const project of projects) {
			await this.removeProject(project);
		}
	}

	async createSession(input = {}) {
		const project = await this.ensureProject(input);
		const context = await this.createSessionContext(project, SessionManager.create(project.directory));
		if (input.title) {
			context.runtime.session.setSessionName(input.title);
		}
		const session = normalizePiSession(
			{
				id: context.runtime.session.sessionId,
				cwd: project.directory,
				name: context.runtime.session.sessionName,
				created: new Date(),
				modified: new Date(),
				firstMessage: input.title || "",
			},
			project,
		);
		this.sendBackendEvent(project, {
			type: "session.created",
			directory: project.directory,
			workspaceId: project.workspaceId,
			session,
		});
		return session;
	}

	async startSession(input) {
		const project = await this.ensureProject(input);
		const context = await this.createSessionContext(project, SessionManager.create(project.directory));
		if (input.title) {
			context.runtime.session.setSessionName(input.title);
		}
		if (input.model) {
			await this.applySelectedModel(context.runtime.session, input.model);
		}
		this.applySelectedVariant(context.runtime.session, input.variant);
		const sessionRef = context.runtime.session;
		const session = normalizePiSession(
			{
				id: sessionRef.sessionId,
				cwd: project.directory,
				name: sessionRef.sessionName || makeSessionTitleFromText(input.text, input.title),
				created: new Date(),
				modified: new Date(),
				firstMessage: input.text,
			},
			project,
		);
		this.sendBackendEvent(project, {
			type: "session.created",
			directory: project.directory,
			workspaceId: project.workspaceId,
			session,
		});
		void this.dispatchSessionPrompt(project, sessionRef, input.text, input.images).catch(() => {});
		return session;
	}

	normalizeImages(images) {
		return (Array.isArray(images) ? images : [])
			.map((image) => parseDataUrl(image))
			.filter(Boolean)
			.map((image) => ({
				type: "image",
				data: image.data,
				mimeType: image.mimeType,
			}));
	}

	handlePromptFailure(project, sessionId, error) {
		this.sendBackendEvent(project, {
			type: "session.error",
			error: error instanceof Error ? error.message : String(error),
			sessionID: sessionId,
		});
		if (project.busySessionIds.has(sessionId)) {
			project.busySessionIds.delete(sessionId);
			this.sendBackendEvent(project, {
				type: "session.status",
				sessionID: sessionId,
				status: sessionStatus("idle"),
			});
		}
	}

	dispatchSessionPrompt(project, session, text, images) {
		const normalizedImages = this.normalizeImages(images);
		let accepted = false;
		let settled = false;
		let resolveAccepted;
		let rejectAccepted;
		const acceptedPromise = new Promise((resolve, reject) => {
			resolveAccepted = resolve;
			rejectAccepted = reject;
		});
		const settleResolve = () => {
			if (settled) return;
			settled = true;
			resolveAccepted();
		};
		const settleReject = (error) => {
			if (settled) return;
			settled = true;
			rejectAccepted(error);
		};
		const promptPromise = session.prompt(text, {
			images: normalizedImages,
			preflightResult: (success) => {
				if (success) {
					accepted = true;
					settleResolve();
				}
			},
		});
		void promptPromise.catch((error) => {
			this.handlePromptFailure(project, session.sessionId, error);
			if (!accepted) {
				settleReject(error);
			}
		});
		return acceptedPromise;
	}

	async applySelectedModel(session, selectedModel) {
		if (!selectedModel?.providerID || !selectedModel?.modelID) return;
		session.modelRegistry.refresh?.();
		const availableModels = session.modelRegistry.getAvailable();
		const knownModels = session.modelRegistry.getAll();
		const discoveredModels = await discoverLocalPiModels(session.sessionManager.getCwd?.(), knownModels);
		const model = mergeModels(availableModels, discoveredModels).find(
			(item) => item.provider === selectedModel.providerID && item.id === selectedModel.modelID,
		);
		if (!model) {
			throw new Error(`Pi model not found: ${selectedModel.providerID}/${selectedModel.modelID}`);
		}
		await session.setModel(model);
	}

	applySelectedVariant(session, variant) {
		if (typeof variant !== "string" || !variant.trim()) return;
		if (typeof session.setThinkingLevel !== "function") return;
		session.setThinkingLevel(variant);
	}

	async deleteSession(sessionId, target) {
		const indexed = this.sessionIndex.get(sessionId);
		const project = indexed
			? await this.ensureProject({ directory: indexed.directory, workspaceId: indexed.workspaceId })
			: await this.ensureProject(target || {});
		let info = this.sessionIndex.get(sessionId);
		if (!info) {
			await this.listSessions({ directory: project.directory, workspaceId: project.workspaceId });
			info = this.sessionIndex.get(sessionId);
		}
		if (!info?.path) {
			throw new Error("Pi session not found");
		}
		const liveContext = this.getLiveSessionContext(project, sessionId);
		if (liveContext && project.busySessionIds.has(sessionId)) {
			throw new Error("Stop Pi session before deleting it.");
		}
		if (liveContext) {
			liveContext.unsubscribe?.();
			await liveContext.runtime.dispose();
			project.liveSessionContexts.delete(sessionId);
			this.syncProjectRuntime(project);
		}
		await unlink(info.path);
		this.sessionIndex.delete(sessionId);
		project.sessionCaches.delete(sessionId);
		project.syntheticStateBySessionId.delete(sessionId);
		this.sendBackendEvent(project, {
			type: "session.deleted",
			directory: project.directory,
			workspaceId: project.workspaceId,
			sessionId,
		});
		return true;
	}

	async updateSession(sessionId, title, target) {
		const indexed = this.sessionIndex.get(sessionId);
		const project = indexed
			? await this.ensureProject({ directory: indexed.directory, workspaceId: indexed.workspaceId })
			: await this.ensureProject(target || {});
		let info = this.sessionIndex.get(sessionId);
		if (!info) {
			await this.listSessions({ directory: project.directory, workspaceId: project.workspaceId });
			info = this.sessionIndex.get(sessionId);
		}
		if (!info?.path) {
			throw new Error("Pi session not found");
		}
		const manager = SessionManager.open(info.path, undefined, info.directory);
		manager.appendSessionInfo(title);
		const session = normalizePiSession(
			{
				id: sessionId,
				cwd: info.directory,
				name: title,
				created: new Date(manager.getHeader().timestamp),
				modified: new Date(),
				firstMessage: title,
			},
			project,
		);
		this.sendBackendEvent(project, {
			type: "session.updated",
			directory: project.directory,
			workspaceId: project.workspaceId,
			session,
		});
		return session;
	}

	async getSessionStatuses(target) {
		if (target?.directory) {
			const project = await this.ensureProject(target);
			const sessions = await this.listSessions(target);
			const statuses = {};
			for (const session of sessions) {
				statuses[session.id] = sessionStatus(project.busySessionIds.has(session.id) ? "busy" : "idle");
			}
			return statuses;
		}
		const statuses = {};
		for (const project of this.projects.values()) {
			const sessions = await this.listSessions({ directory: project.directory, workspaceId: project.workspaceId });
			for (const session of sessions) {
				statuses[session.id] = sessionStatus(project.busySessionIds.has(session.id) ? "busy" : "idle");
			}
		}
		return statuses;
	}

	async forkSession(sessionId, messageID, target) {
		const indexed = this.sessionIndex.get(sessionId);
		const project = indexed
			? await this.ensureProject({ directory: indexed.directory, workspaceId: indexed.workspaceId })
			: await this.ensureProject(target || {});
		let info = this.sessionIndex.get(sessionId);
		if (!info) {
			await this.listSessions({ directory: project.directory, workspaceId: project.workspaceId });
			info = this.sessionIndex.get(sessionId);
		}
		if (!info?.path) {
			throw new Error("Pi session not found");
		}
		const realMessageId = messageID ? this.resolveRealMessageId(project, sessionId, messageID) : undefined;
		const sourceManager = SessionManager.open(info.path, undefined, info.directory);
		let targetLeafId = realMessageId ?? sourceManager.getLeafId();
		if (realMessageId) {
			const selectedEntry = sourceManager.getEntry(realMessageId);
			if (!selectedEntry) {
				throw new Error("Invalid entry ID for forking");
			}
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
		}
		const forkedPath = sourceManager.createBranchedSession(targetLeafId);
		if (!forkedPath) {
			throw new Error("Failed to create forked session");
		}
		const forkContext = await this.createSessionContext(
			project,
			SessionManager.open(forkedPath, undefined, info.directory),
		);
		const session = normalizePiSession(
			{
				id: forkContext.runtime.session.sessionId,
				cwd: project.directory,
				name: forkContext.runtime.session.sessionName,
				created: new Date(),
				modified: new Date(),
				firstMessage: "",
			},
			project,
		);
		this.sendBackendEvent(project, {
			type: "session.created",
			directory: project.directory,
			workspaceId: project.workspaceId,
			session,
		});
		return session;
	}

	async getProviders(target) {
		if (target?.directory) {
			const project = await this.ensureProject(target);
			const runtime = project.runtime || project.liveSessionContexts.values().next().value?.runtime || null;
			if (!runtime) {
				throw new Error("Pi project runtime not ready");
			}
			runtime.services.modelRegistry.refresh?.();
			const availableModels = runtime.services.modelRegistry.getAvailable();
			const knownModels = runtime.services.modelRegistry.getAll();
			const discoveredModels = await discoverLocalPiModels(project.directory, knownModels);
			return buildProvidersData(mergeModels(availableModels, discoveredModels));
		}
		const models = [];
		for (const project of this.projects.values()) {
			const runtime = project.runtime || project.liveSessionContexts.values().next().value?.runtime || null;
			if (!runtime) continue;
			runtime.services.modelRegistry.refresh?.();
			const availableModels = runtime.services.modelRegistry.getAvailable();
			const knownModels = runtime.services.modelRegistry.getAll();
			models.push(...mergeModels(availableModels, await discoverLocalPiModels(project.directory, knownModels)));
		}
		return buildProvidersData(models);
	}

	async getAgents() {
		return [];
	}

	async getCommands(target) {
		const project = target?.directory
			? await this.ensureProject(target)
			: this.projects.values().next().value;
		if (!project) return [];
		const runtime = project.runtime || project.liveSessionContexts.values().next().value?.runtime || null;
		if (!runtime) return [];
		const session = runtime.session;
		const extensionCommands = session.extensionRunner.getRegisteredCommands().map((command) => ({
			name: command.invocationName,
			description: command.description,
			source: "command",
			template: `/${command.invocationName}`,
			hints: [],
		}));
		const promptCommands = session.promptTemplates.map((template) => ({
			name: template.name,
			description: template.description,
			source: "command",
			template: `/${template.name}`,
			hints: [],
		}));
		const skillCommands = session.resourceLoader.getSkills().skills.map((skill) => ({
			name: `skill:${skill.name}`,
			description: skill.description,
			source: "skill",
			template: `/skill:${skill.name}`,
			hints: [],
		}));
		return [...extensionCommands, ...promptCommands, ...skillCommands];
	}

	async getMessages(sessionId, _options, target) {
		const indexed = this.sessionIndex.get(sessionId);
		const project = indexed
			? await this.ensureProject({ directory: indexed.directory, workspaceId: indexed.workspaceId })
			: await this.ensureProject(target || {});
		const liveContext = this.getLiveSessionContext(project, sessionId);
		if (liveContext) {
			const cache = this.getSessionCache(project, sessionId);
			return {
				messages: cache.messages.map((bundle) => cloneBundle(bundle)),
				nextCursor: null,
			};
		}
		let info = indexed;
		if (!info) {
			await this.listSessions({ directory: project.directory, workspaceId: project.workspaceId });
			info = this.sessionIndex.get(sessionId);
		}
		if (!info?.path) {
			throw new Error("Pi session not found");
		}
		const manager = SessionManager.open(info.path, undefined, info.directory);
		const cache = buildTranscriptFromSessionManager(manager, info.directory);
		return {
			messages: cache.messages.map((bundle) => cloneBundle(bundle)),
			nextCursor: null,
		};
	}

	async prompt(sessionId, text, images, model, _agent, variant, directory, workspaceId) {
		const { project, session } = await this.ensureSessionContext(sessionId, { directory, workspaceId });
		if (model) {
			await this.applySelectedModel(session, model);
		}
		this.applySelectedVariant(session, variant);
		await this.dispatchSessionPrompt(project, session, text, images);
		return project;
	}

	async abort(sessionId) {
		const indexed = this.sessionIndex.get(sessionId);
		const project = indexed
			? await this.ensureProject({ directory: indexed.directory, workspaceId: indexed.workspaceId })
			: null;
		if (!project) {
			throw new Error("Pi session not found");
		}
		const liveContext = this.getLiveSessionContext(project, sessionId);
		if (!liveContext) {
			throw new Error("Pi session not active");
		}
		await liveContext.runtime.session.abort();
	}

	async summarizeSession(sessionId, model, directory, workspaceId) {
		const { session } = await this.ensureSessionContext(sessionId, { directory, workspaceId });
		if (model) {
			await this.applySelectedModel(session, model);
		}
		await session.compact();
	}

	async sendCommand(sessionId, command, args, model, _agent, _variant, directory, workspaceId) {
		const text = `/${command}${args ? ` ${args}` : ""}`;
		await this.prompt(sessionId, text, [], model, undefined, undefined, directory, workspaceId);
	}

	async findFiles(directory, _workspaceId, query) {
		const cwd = normalizeDir(directory);
		if (!cwd) return [];
		const q = String(query || "").trim().toLowerCase();
		if (!q) return [];
		try {
			const { stdout } = await execFile("rg", ["--files"], { cwd, maxBuffer: 1024 * 1024 * 8 });
			return stdout
				.split(/\r?\n/)
				.filter(Boolean)
				.filter((file) => file.toLowerCase().includes(q))
				.slice(0, 200);
		} catch {
			return [];
		}
	}
}

function daemonInfoPath(userData) {
	return join(userData || process.cwd(), "pi-daemon.json");
}

async function fileExists(path) {
	try {
		await readFile(path, "utf8");
		return true;
	} catch {
		return false;
	}
}

async function findFreePort() {
	return await new Promise((resolve, reject) => {
		const server = createNetServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

async function readDaemonInfo(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return null;
	}
}

async function writeDaemonInfo(path, info) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(info, null, 2), "utf8");
}

async function fetchDaemonJson(baseUrl, token, path, options = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeout ?? PI_DAEMON_HEALTH_TIMEOUT);
	try {
		const response = await fetch(`${baseUrl}${path}`, {
			...options,
			signal: controller.signal,
			headers: {
				"content-type": "application/json",
				"x-opengui-pi-token": token,
				...options.headers,
			},
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return await response.json();
	} finally {
		clearTimeout(timer);
	}
}

class PiDaemonClient {
	constructor(getAllWindows, options = {}) {
		this.getAllWindows = getAllWindows;
		this.userData = options.userData || process.cwd();
		this.infoPath = daemonInfoPath(this.userData);
		this.info = null;
		this.startPromise = null;
		this.eventAbort = null;
		this.eventReconnectTimer = null;
		this.eventStarted = false;
	}

	async addProject(config) {
		return await this.call("addProject", [config]);
	}

	async removeProject(target) {
		return await this.call("removeProject", [target]);
	}

	async disconnect() {
		// Client-side disconnect only. Background daemon and running Pi sessions stay alive.
		this.stopEvents();
		this.info = null;
		return true;
	}

	async listSessions(target) {
		return await this.call("listSessions", [target]);
	}

	async createSession(input) {
		return await this.call("createSession", [input]);
	}

	async deleteSession(sessionId, target) {
		return await this.call("deleteSession", [sessionId, target]);
	}

	async updateSession(sessionId, title, target) {
		return await this.call("updateSession", [sessionId, title, target]);
	}

	async getSessionStatuses(target) {
		return await this.call("getSessionStatuses", [target]);
	}

	async forkSession(sessionId, messageID, target) {
		return await this.call("forkSession", [sessionId, messageID, target]);
	}

	async getProviders(target) {
		return await this.call("getProviders", [target]);
	}

	async getAgents() {
		return await this.call("getAgents", []);
	}

	async getCommands(target) {
		return await this.call("getCommands", [target]);
	}

	async getMessages(sessionId, options, target) {
		return await this.call("getMessages", [sessionId, options, target]);
	}

	async startSession(input) {
		return await this.call("startSession", [input]);
	}

	async prompt(sessionId, text, images, model, agent, variant, directory, workspaceId) {
		return await this.call("prompt", [sessionId, text, images, model, agent, variant, directory, workspaceId]);
	}

	async abort(sessionId) {
		return await this.call("abort", [sessionId]);
	}

	async sendCommand(sessionId, command, args, model, agent, variant, directory, workspaceId) {
		return await this.call("sendCommand", [sessionId, command, args, model, agent, variant, directory, workspaceId]);
	}

	async summarizeSession(sessionId, model, directory, workspaceId) {
		return await this.call("summarizeSession", [sessionId, model, directory, workspaceId]);
	}

	async findFiles(directory, workspaceId, query) {
		return await this.call("findFiles", [directory, workspaceId, query]);
	}

	async call(method, args) {
		const info = await this.ensureDaemon();
		const result = await fetchDaemonJson(info.baseUrl, info.token, "/rpc", {
			method: "POST",
			body: JSON.stringify({ method, args }),
			timeout: 30_000,
		});
		if (!result.success) throw new Error(result.error || `Pi daemon call failed: ${method}`);
		return result.data;
	}

	async ensureDaemon() {
		if (this.info && (await this.isHealthy(this.info))) return this.info;
		if (this.startPromise) return await this.startPromise;
		this.startPromise = this.startDaemon();
		try {
			this.info = await this.startPromise;
			if (!this.eventStarted) this.startEvents();
			return this.info;
		} finally {
			this.startPromise = null;
		}
	}

	async getHealth(info) {
		if (!info?.baseUrl || !info?.token) return null;
		try {
			return await fetchDaemonJson(info.baseUrl, info.token, "/health");
		} catch {
			return null;
		}
	}

	async isHealthy(info) {
		const health = await this.getHealth(info);
		return Boolean(health?.success && health?.data?.daemonVersion === PI_DAEMON_VERSION);
	}

	async stopDaemon(info) {
		if (!info?.baseUrl || !info?.token) return;
		try {
			await fetchDaemonJson(info.baseUrl, info.token, "/shutdown", {
				method: "POST",
				timeout: 1_000,
			});
		} catch {
			// Best effort. A stale daemon may already be gone.
		}
	}

	async startDaemon() {
		const existing = await readDaemonInfo(this.infoPath);
		const existingHealth = await this.getHealth(existing);
		if (existingHealth?.success && existingHealth?.data?.daemonVersion === PI_DAEMON_VERSION) return existing;
		if (existingHealth?.success) await this.stopDaemon(existing);

		const port = Number(await findFreePort());
		if (!port) throw new Error("Could not allocate Pi daemon port");
		const token = randomUUID();
		const baseUrl = `http://127.0.0.1:${port}`;
		const daemonPath = join(__dirname, "pi-daemon-server.mjs");
		if (!(await fileExists(daemonPath))) throw new Error(`Pi daemon script not found: ${daemonPath}`);

		let logs = "";
		const appendLog = (chunk) => {
			if (logs.length < 8192) logs += chunk.toString().slice(0, 8192 - logs.length);
		};
		const child = spawn(process.execPath, [daemonPath, "--port", String(port), "--token", token], {
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: "1",
				OPENGUI_PI_DAEMON_PORT: String(port),
				OPENGUI_PI_DAEMON_TOKEN: token,
				OPENGUI_PI_DAEMON_VERSION: PI_DAEMON_VERSION,
			},
		});
		child.stdout?.on("data", appendLog);
		child.stderr?.on("data", appendLog);
		child.unref();

		const startedAt = Date.now();
		const info = { pid: child.pid, port, token, baseUrl, startedAt };
		while (Date.now() - startedAt < PI_DAEMON_STARTUP_TIMEOUT) {
			if (await this.isHealthy(info)) {
				child.stdout?.removeAllListeners("data");
				child.stderr?.removeAllListeners("data");
				child.stdout?.destroy();
				child.stderr?.destroy();
				await writeDaemonInfo(this.infoPath, info);
				return info;
			}
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		throw new Error(`Pi daemon did not become healthy. ${logs.trim()}`.trim());
	}

	startEvents() {
		this.eventStarted = true;
		void this.connectEvents();
	}

	stopEvents() {
		this.eventStarted = false;
		if (this.eventReconnectTimer) clearTimeout(this.eventReconnectTimer);
		this.eventReconnectTimer = null;
		this.eventAbort?.abort();
		this.eventAbort = null;
	}

	scheduleEventReconnect() {
		if (!this.eventStarted || this.eventReconnectTimer) return;
		this.eventReconnectTimer = setTimeout(() => {
			this.eventReconnectTimer = null;
			void this.connectEvents();
		}, PI_DAEMON_SSE_RECONNECT_DELAY);
	}

	async connectEvents() {
		if (!this.eventStarted) return;
		let info;
		try {
			info = await this.ensureDaemon();
		} catch {
			this.scheduleEventReconnect();
			return;
		}
		this.eventAbort?.abort();
		const controller = new AbortController();
		this.eventAbort = controller;
		try {
			const response = await fetch(`${info.baseUrl}/events`, {
				signal: controller.signal,
				headers: { "x-opengui-pi-token": info.token },
			});
			if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			while (this.eventStarted) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let index;
				while ((index = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, index).trim();
					buffer = buffer.slice(index + 1);
					if (!line || line.startsWith(":")) continue;
					const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
					if (!payload) continue;
					this.forwardEvent(JSON.parse(payload));
				}
			}
		} catch {
			// Reconnect below unless this was an intentional disconnect.
		} finally {
			if (this.eventAbort === controller) this.eventAbort = null;
			this.scheduleEventReconnect();
		}
	}

	forwardEvent(event) {
		for (const window of this.getAllWindows()) {
			if (window?.isDestroyed?.()) continue;
			window.webContents.send("pi:bridge-event", event);
		}
	}
}

export function setupPiBridge(ipcMain, getAllWindows, options = {}) {
	const manager = new PiDaemonClient(getAllWindows, options);
	void manager.ensureDaemon().catch((error) => {
		console.error("Failed to start Pi daemon:", error);
	});

	ipcMain.handle("pi:project:add", async (_event, config) => {
		try {
			await manager.addProject(config);
			return ok(true);
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("pi:project:remove", async (_event, directory, workspaceId) => {
		try {
			await manager.removeProject({ directory, workspaceId });
			return ok(true);
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("pi:disconnect", async () => {
		try {
			await manager.disconnect();
			return ok(true);
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("pi:session:list", async (_event, directory, workspaceId) => {
		try {
			return ok(await manager.listSessions({ directory, workspaceId }));
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("pi:session:create", async (_event, title, directory, workspaceId) => {
		try {
			return ok(await manager.createSession({ title, directory, workspaceId }));
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("pi:session:delete", async (_event, sessionId, directory, workspaceId) => {
		try {
			return ok(await manager.deleteSession(sessionId, { directory, workspaceId }));
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("pi:session:update", async (_event, sessionId, title, directory, workspaceId) => {
		try {
			return ok(await manager.updateSession(sessionId, title, { directory, workspaceId }));
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("pi:session:statuses", async (_event, directory, workspaceId) => {
		try {
			return ok(await manager.getSessionStatuses({ directory, workspaceId }));
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("pi:session:fork", async (_event, sessionId, messageID, directory, workspaceId) => {
		try {
			return ok(await manager.forkSession(sessionId, messageID, { directory, workspaceId }));
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("pi:providers", async (_event, directory, workspaceId) => {
		try {
			return ok(await manager.getProviders({ directory, workspaceId }));
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("pi:agents", async () => {
		try {
			return ok(await manager.getAgents());
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("pi:commands", async (_event, directory, workspaceId) => {
		try {
			return ok(await manager.getCommands({ directory, workspaceId }));
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("pi:messages", async (_event, sessionId, options, directory, workspaceId) => {
		try {
			return ok(await manager.getMessages(sessionId, options, { directory, workspaceId }));
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("pi:session:start", async (_event, input) => {
		try {
			return ok(await manager.startSession(input));
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("pi:prompt", async (_event, sessionId, text, images, model, agent, variant, directory, workspaceId) => {
		try {
			await manager.prompt(sessionId, text, images, model, agent, variant, directory, workspaceId);
			return ok(true);
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("pi:abort", async (_event, sessionId) => {
		try {
			await manager.abort(sessionId);
			return ok(true);
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("pi:command:send", async (_event, sessionId, command, args, model, agent, variant, directory, workspaceId) => {
		try {
			await manager.sendCommand(sessionId, command, args, model, agent, variant, directory, workspaceId);
			return ok(true);
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("pi:session:summarize", async (_event, sessionId, model, directory, workspaceId) => {
		try {
			await manager.summarizeSession(sessionId, model, directory, workspaceId);
			return ok(true);
		} catch (error) {
			return fail(error);
		}
	});

	ipcMain.handle("pi:find:files", async (_event, directory, workspaceId, query) => {
		try {
			return ok(await manager.findFiles(directory, workspaceId, query));
		} catch (error) {
			return fail(error);
		}
	});
}
