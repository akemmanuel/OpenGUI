/**
 * Central React context + hook for OpenCode connection state.
 *
 * Provides connection lifecycle, session management, messages,
 * variant selection, and real-time SSE event handling to the entire
 * component tree.
 *
 * Uses v2 SDK types which include variant support on models.
 */

import type {
	Agent,
	Command,
	Message,
	Model,
	Event as OpenCodeEvent,
	Part,
	PermissionRequest,
	Provider,
	QuestionAnswer,
	QuestionRequest,
	Session,
} from "@opencode-ai/sdk/v2/client";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useReducer,
	useRef,
} from "react";
import type {
	BridgeEvent,
	ConnectionConfig,
	ConnectionStatus,
	ProvidersData,
	SelectedModel,
} from "@/types/electron";

// ---------------------------------------------------------------------------
// Variant helpers (ported from opencode's model-variant.ts)
// ---------------------------------------------------------------------------

/** Key used to store per-model variant selections */
function variantKey(providerID: string, modelID: string): string {
	return `${providerID}/${modelID}`;
}

/** Map of providerID/modelID -> selected variant name (undefined = default) */
export type VariantSelections = Record<string, string | undefined>;

/**
 * Cycle to the next variant for a given model.
 * Order: undefined (default) -> first variant -> second -> ... -> undefined again
 */
function cycleVariant(
	current: string | undefined,
	model: Model | undefined,
): string | undefined {
	if (!model?.variants) return undefined;
	const keys = Object.keys(model.variants).filter(
		(k) => !model.variants?.[k]?.disabled,
	);
	if (keys.length === 0) return undefined;
	if (current === undefined) return keys[0];
	const idx = keys.indexOf(current);
	if (idx < 0 || idx >= keys.length - 1) return undefined;
	return keys[idx + 1];
}

/** Resolve the effective variant: explicit selection > agent default > undefined */
export function resolveVariant(
	selectedModel: SelectedModel | null,
	variantSelections: VariantSelections,
	agents: Agent[],
	selectedAgent: string | null,
): string | undefined {
	if (!selectedModel) return undefined;
	const key = variantKey(selectedModel.providerID, selectedModel.modelID);
	const explicit = variantSelections[key];
	if (explicit !== undefined) return explicit;
	// Check if the selected agent has a default variant
	if (selectedAgent) {
		const agent = agents.find((a) => a.name === selectedAgent);
		if (agent?.variant) return agent.variant;
	}
	return undefined;
}

/** Resolve the first valid server default model from provider defaults. */
export function resolveServerDefaultModel(
	providers: Provider[],
	providerDefaults: Record<string, string>,
): SelectedModel | null {
	// Format A (newer servers): { [providerID]: modelID }
	for (const provider of providers) {
		const modelID = providerDefaults[provider.id];
		if (typeof modelID !== "string") continue;
		if (!(modelID in provider.models)) continue;
		return { providerID: provider.id, modelID };
	}

	// Format B (older servers): { [agentOrScope]: "providerID/modelID" }
	for (const raw of Object.values(providerDefaults)) {
		if (typeof raw !== "string") continue;
		const splitIdx = raw.indexOf("/");
		if (splitIdx <= 0 || splitIdx >= raw.length - 1) continue;
		const providerID = raw.slice(0, splitIdx);
		const modelID = raw.slice(splitIdx + 1);
		const provider = providers.find((p) => p.id === providerID);
		if (!provider || !(modelID in provider.models)) continue;
		return { providerID, modelID };
	}
	return null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface RecentProject {
	directory: string;
	serverUrl: string;
	username?: string;
	lastConnected: number;
}

const RECENT_PROJECTS_KEY = "opencode:recentProjects";
const OPEN_PROJECTS_KEY = "opencode:openProjects";
const UNREAD_SESSIONS_KEY = "opencode:unreadSessionIds";
const NOTIFICATIONS_ENABLED_KEY = "opencode:notificationsEnabled";
const SESSION_META_KEY = "opencode:sessionMeta";
const WORKTREE_PARENTS_KEY = "opencode:worktreeParents";
const MAX_RECENT_PROJECTS = 10;

// ---------------------------------------------------------------------------
// Session meta (local-only tags & colors)
// ---------------------------------------------------------------------------

export type SessionColor =
	| "red"
	| "orange"
	| "yellow"
	| "green"
	| "blue"
	| "purple"
	| "pink"
	| "gray"
	| null;

export interface SessionMeta {
	color?: SessionColor;
	tags?: string[];
}

export type SessionMetaMap = Record<string, SessionMeta>;

function getSessionMetaMap(): SessionMetaMap {
	try {
		const raw = localStorage.getItem(SESSION_META_KEY);
		if (!raw) return {};
		return JSON.parse(raw) as SessionMetaMap;
	} catch {
		return {};
	}
}

function persistSessionMetaMap(meta: SessionMetaMap) {
	try {
		// Prune empty entries
		const pruned: SessionMetaMap = {};
		for (const [id, m] of Object.entries(meta)) {
			if ((m.color && m.color !== null) || (m.tags && m.tags.length > 0)) {
				pruned[id] = m;
			}
		}
		if (Object.keys(pruned).length === 0) {
			localStorage.removeItem(SESSION_META_KEY);
		} else {
			localStorage.setItem(SESSION_META_KEY, JSON.stringify(pruned));
		}
	} catch {
		/* ignore */
	}
}

// ---------------------------------------------------------------------------
// Worktree parents (maps worktree directory -> parent project directory)
// ---------------------------------------------------------------------------

/** Maps worktree directory -> parent project directory */
export type WorktreeParentMap = Record<string, string>;

function getWorktreeParents(): WorktreeParentMap {
	try {
		const raw = localStorage.getItem(WORKTREE_PARENTS_KEY);
		if (!raw) return {};
		return JSON.parse(raw) as WorktreeParentMap;
	} catch {
		return {};
	}
}

function persistWorktreeParents(map: WorktreeParentMap) {
	try {
		if (Object.keys(map).length === 0) {
			localStorage.removeItem(WORKTREE_PARENTS_KEY);
		} else {
			localStorage.setItem(WORKTREE_PARENTS_KEY, JSON.stringify(map));
		}
	} catch {
		/* ignore */
	}
}

/**
 * Returns true when the configured opencode server points to the local machine.
 * Used to decide whether native Electron dialogs make sense (local) or whether
 * the user should type a remote path instead.
 */
function isLocalServer(): boolean {
	const raw =
		localStorage.getItem("opencode:serverUrl") ?? "http://127.0.0.1:4096";
	try {
		const hostname = new URL(raw).hostname;
		return ["localhost", "127.0.0.1", "::1"].includes(hostname);
	} catch {
		return false;
	}
}

function getRecentProjects(): RecentProject[] {
	try {
		const raw = localStorage.getItem(RECENT_PROJECTS_KEY);
		if (!raw) return [];
		return JSON.parse(raw) as RecentProject[];
	} catch {
		return [];
	}
}

function addRecentProject(project: RecentProject): RecentProject[] {
	const existing = getRecentProjects().filter(
		(p) => p.directory !== project.directory,
	);
	const updated = [project, ...existing].slice(0, MAX_RECENT_PROJECTS);
	try {
		localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(updated));
	} catch {
		/* ignore */
	}
	return updated;
}

function getOpenProjects(): RecentProject[] {
	try {
		const raw = localStorage.getItem(OPEN_PROJECTS_KEY);
		if (!raw) return [];
		return JSON.parse(raw) as RecentProject[];
	} catch {
		return [];
	}
}

function setOpenProjects(projects: RecentProject[]) {
	try {
		localStorage.setItem(OPEN_PROJECTS_KEY, JSON.stringify(projects));
	} catch {
		/* ignore */
	}
}

function upsertOpenProject(project: RecentProject): RecentProject[] {
	const existing = getOpenProjects().filter(
		(p) => p.directory !== project.directory,
	);
	const updated = [project, ...existing];
	setOpenProjects(updated);
	return updated;
}

function removeOpenProject(directory: string): RecentProject[] {
	const updated = getOpenProjects().filter((p) => p.directory !== directory);
	setOpenProjects(updated);
	return updated;
}

function clearOpenProjects() {
	try {
		localStorage.removeItem(OPEN_PROJECTS_KEY);
	} catch {
		/* ignore */
	}
}

function getUnreadSessionIds(): Set<string> {
	try {
		const raw = localStorage.getItem(UNREAD_SESSIONS_KEY);
		if (!raw) return new Set();
		return new Set(JSON.parse(raw) as string[]);
	} catch {
		return new Set();
	}
}

function persistUnreadSessionIds(ids: Set<string>) {
	try {
		if (ids.size === 0) {
			localStorage.removeItem(UNREAD_SESSIONS_KEY);
		} else {
			localStorage.setItem(UNREAD_SESSIONS_KEY, JSON.stringify([...ids]));
		}
	} catch {
		/* ignore */
	}
}

function areNotificationsEnabled(): boolean {
	try {
		const raw = localStorage.getItem(NOTIFICATIONS_ENABLED_KEY);
		// Default to true if no preference stored
		return raw === null || raw === "true";
	} catch {
		return true;
	}
}

export interface QueuedPrompt {
	id: string;
	text: string;
	images?: string[];
	createdAt: number;
	model?: SelectedModel;
	agent?: string;
	variant?: string;
}

export interface MessageEntry {
	info: Message;
	parts: Part[];
}

export interface OpenCodeState {
	/** Per-project connection statuses keyed by directory */
	connections: Record<string, ConnectionStatus>;
	/** All sessions from all connected projects */
	sessions: Session[];
	/** Currently selected session ID */
	activeSessionId: string | null;
	/** Messages for the active session */
	messages: MessageEntry[];
	/** Whether messages are being fetched for a newly selected session */
	isLoadingMessages: boolean;
	/** Whether a prompt response is in-flight */
	isBusy: boolean;
	/** Pending permission requests keyed by sessionID */
	pendingPermissions: Record<string, PermissionRequest>;
	/** Pending questions keyed by sessionID */
	pendingQuestions: Record<string, QuestionRequest>;
	/** Last error surfaced to UI */
	lastError: string | null;
	/** App startup status for local server bootstrap */
	bootState: "idle" | "checking-server" | "starting-server" | "ready" | "error";
	/** Startup error shown only when bootstrap fails */
	bootError: string | null;
	/** Available providers and their models */
	providers: Provider[];
	/** Default model mappings from server config */
	providerDefaults: { [key: string]: string };
	/** Currently selected model for prompts (null until resolved/selected) */
	selectedModel: SelectedModel | null;
	/** Set of session IDs that are currently busy (generating) */
	busySessionIds: Set<string>;
	/** Available agents from the server */
	agents: Agent[];
	/** Currently selected agent name (null = server default) */
	selectedAgent: string | null;
	/** Per-model variant selections */
	variantSelections: VariantSelections;
	/** Available slash commands from the server */
	commands: Command[];
	/** Per-session queued prompts (sent automatically when session becomes idle) */
	queuedPrompts: Record<string, QueuedPrompt[]>;
	/** Recently opened projects */
	recentProjects: RecentProject[];
	/** Directory for a draft (not-yet-created) session. Null when no draft is active. */
	draftSessionDirectory: string | null;
	/** Whether the current draft should create a temporary (non-persisted) session */
	draftIsTemporary: boolean;
	/** Set of session IDs marked as temporary (auto-deleted on navigate away) */
	temporarySessions: Set<string>;
	/** Set of session IDs that have unread content (finished generating while not active) */
	unreadSessionIds: Set<string>;
	/** Local-only session metadata (colors, tags) keyed by session ID */
	sessionMeta: SessionMetaMap;
	/** Maps worktree directory -> parent project directory (local-only) */
	worktreeParents: WorktreeParentMap;
	/** Messages/parts for child (subagent) sessions, keyed by child sessionID */
	childSessions: Record<
		string,
		Record<string, { info: Message; parts: Record<string, Part> }>
	>;
	/** Set of child session IDs we're actively tracking (from running Task tool parts) */
	trackedChildSessionIds: Set<string>;
	/** Snapshot events queued while messages are loading for the active session */
	_pendingSnapshots: Array<
		| { type: "MESSAGE_UPDATED"; payload: Message }
		| { type: "PART_UPDATED"; payload: { part: Part } }
		| {
				type: "PART_DELTA";
				payload: {
					sessionID: string;
					messageID: string;
					partID: string;
					field: string;
					delta: string;
				};
		  }
		| {
				type: "PART_REMOVED";
				payload: { sessionID: string; messageID: string; partID: string };
		  }
	>;
	/** Buffered message snapshots for non-active busy sessions (keyed by sessionID) */
	_sessionBuffers: Record<
		string,
		Record<string, { info: Message; parts: Record<string, Part> }>
	>;
}

/** Check if any project is connected. */
export function hasAnyConnection(
	connections: Record<string, ConnectionStatus>,
): boolean {
	return Object.values(connections).some((c) => c.state === "connected");
}

const initialState: OpenCodeState = {
	connections: {},
	sessions: [],
	activeSessionId: null,
	messages: [],
	isLoadingMessages: false,
	isBusy: false,
	pendingPermissions: {},
	pendingQuestions: {},
	lastError: null,
	bootState: "idle",
	bootError: null,
	providers: [],
	providerDefaults: {},
	selectedModel: null,
	busySessionIds: new Set(),
	agents: [],
	selectedAgent: null,
	variantSelections: {},
	commands: [],
	queuedPrompts: {},
	recentProjects: getRecentProjects(),
	draftSessionDirectory: null,
	draftIsTemporary: false,
	temporarySessions: new Set(),
	unreadSessionIds: getUnreadSessionIds(),
	sessionMeta: getSessionMetaMap(),
	worktreeParents: getWorktreeParents(),
	childSessions: {},
	trackedChildSessionIds: new Set(),
	_pendingSnapshots: [],
	_sessionBuffers: {},
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type Action =
	| {
			type: "SET_PROJECT_CONNECTION";
			payload: { directory: string; status: ConnectionStatus };
	  }
	| { type: "REMOVE_PROJECT"; payload: string }
	| { type: "CLEAR_ALL_PROJECTS" }
	| { type: "SET_SESSIONS"; payload: Session[] }
	| {
			type: "MERGE_PROJECT_SESSIONS";
			payload: { directory: string; sessions: Session[] };
	  }
	| { type: "SET_ACTIVE_SESSION"; payload: string | null }
	| { type: "SET_MESSAGES"; payload: MessageEntry[] }
	| { type: "SET_BUSY"; payload: boolean }
	| { type: "SET_ERROR"; payload: string | null }
	| {
			type: "SET_BOOT_STATE";
			payload: {
				state: OpenCodeState["bootState"];
				error?: string | null;
			};
	  }
	| {
			type: "SET_PERMISSION";
			payload: PermissionRequest | { sessionID: string; clear: true };
	  }
	| {
			type: "SET_QUESTION";
			payload: QuestionRequest | { sessionID: string; clear: true };
	  }
	| { type: "SET_PROVIDERS"; payload: ProvidersData }
	| { type: "SET_SELECTED_MODEL"; payload: SelectedModel | null }
	| { type: "SET_AGENTS"; payload: Agent[] }
	| { type: "SET_COMMANDS"; payload: Command[] }
	| { type: "SET_SELECTED_AGENT"; payload: string | null }
	| { type: "SET_VARIANT_SELECTIONS"; payload: VariantSelections }
	| { type: "SESSION_CREATED"; payload: Session }
	| { type: "SESSION_UPDATED"; payload: Session }
	| { type: "SESSION_DELETED"; payload: string }
	| { type: "MESSAGE_UPDATED"; payload: Message }
	| { type: "PART_UPDATED"; payload: { part: Part } }
	| {
			type: "PART_DELTA";
			payload: {
				sessionID: string;
				messageID: string;
				partID: string;
				field: string;
				delta: string;
			};
	  }
	| {
			type: "PART_REMOVED";
			payload: { sessionID: string; messageID: string; partID: string };
	  }
	| {
			type: "SESSION_STATUS";
			payload: { sessionID: string; status: { type: string } };
	  }
	| {
			type: "INIT_BUSY_SESSIONS";
			payload: Record<string, { type: string }>;
	  }
	| { type: "QUEUE_ADD"; payload: { sessionID: string; prompt: QueuedPrompt } }
	| { type: "QUEUE_SHIFT"; payload: { sessionID: string } }
	| { type: "QUEUE_REMOVE"; payload: { sessionID: string; promptID: string } }
	| {
			type: "QUEUE_REORDER";
			payload: { sessionID: string; fromIndex: number; toIndex: number };
	  }
	| {
			type: "QUEUE_UPDATE";
			payload: { sessionID: string; promptID: string; text: string };
	  }
	| { type: "QUEUE_CLEAR"; payload: { sessionID: string } }
	| { type: "SET_RECENT_PROJECTS"; payload: RecentProject[] }
	| { type: "START_DRAFT_SESSION"; payload: string }
	| { type: "CLEAR_DRAFT_SESSION" }
	| { type: "SET_DRAFT_TEMPORARY"; payload: boolean }
	| { type: "MARK_SESSION_TEMPORARY"; payload: string }
	| { type: "UNMARK_SESSION_TEMPORARY"; payload: string }
	| {
			type: "SET_SESSION_META";
			payload: { sessionId: string; meta: SessionMeta };
	  }
	| {
			type: "REGISTER_WORKTREE";
			payload: { worktreeDir: string; parentDir: string };
	  }
	| { type: "UNREGISTER_WORKTREE"; payload: string }
	| {
			type: "LOAD_CHILD_SESSION";
			payload: {
				childSessionId: string;
				messages: Array<{ info: Message; parts: Part[] }>;
			};
	  };

function getSessionSortTime(session: Session): number {
	return session.time.updated ?? session.time.created ?? 0;
}

function sortSessionsNewestFirst(sessions: Session[]): Session[] {
	return [...sessions].sort((a, b) => {
		const byUpdated = getSessionSortTime(b) - getSessionSortTime(a);
		if (byUpdated !== 0) return byUpdated;
		return b.id.localeCompare(a.id);
	});
}

type DeltaTrackedPart = Part & { _deltaPositions?: Record<string, number> };

function createPlaceholderMessageEntry(
	sessionID: string,
	messageID: string,
): MessageEntry {
	return {
		info: { id: messageID, sessionID } as Message,
		parts: [],
	};
}

function createPlaceholderPart(
	sessionID: string,
	messageID: string,
	partID: string,
	field: string,
): DeltaTrackedPart {
	return {
		id: partID,
		type: "text",
		text: "",
		sessionID,
		messageID,
		[field]: "",
		_deltaPositions: { [field]: 0 },
	} as DeltaTrackedPart;
}

function tagPartWithDeltaPositions(
	part: Part,
	previous?: Part,
): DeltaTrackedPart {
	const prevPositions = (previous as Record<string, unknown> | undefined)
		?._deltaPositions as Record<string, number> | undefined;
	const normalizedPositions: Record<string, number> = {};

	if (prevPositions) {
		const partRecord = part as Record<string, unknown>;
		for (const [key, pos] of Object.entries(prevPositions)) {
			if (!Number.isFinite(pos)) continue;
			const value = partRecord[key];
			if (typeof value !== "string") continue;
			normalizedPositions[key] = Math.min(Math.max(pos, 0), value.length);
		}
	} else {
		const partRecord = part as Record<string, unknown>;
		for (const [key, value] of Object.entries(partRecord)) {
			if (typeof value === "string" && value.length > 0) {
				normalizedPositions[key] = value.length;
			}
		}
	}

	return {
		...part,
		_deltaPositions: normalizedPositions,
	} as DeltaTrackedPart;
}

function mergeSnapshotPartWithExisting(
	part: Part,
	previous?: Part,
): DeltaTrackedPart {
	const tagged = tagPartWithDeltaPositions(part, previous);
	if (!previous) return tagged;

	const prevRecord = previous as Record<string, unknown>;
	const nextRecord = tagged as Record<string, unknown>;
	const prevPositions =
		(prevRecord._deltaPositions as Record<string, number> | undefined) ?? {};
	const mergedPositions = {
		...((nextRecord._deltaPositions as Record<string, number> | undefined) ??
			{}),
	};

	for (const [field, prevPosRaw] of Object.entries(prevPositions)) {
		if (!Number.isFinite(prevPosRaw)) continue;
		const prevVal = prevRecord[field];
		const nextVal = nextRecord[field];
		if (typeof prevVal !== "string" || typeof nextVal !== "string") continue;

		// PART_UPDATED snapshots can lag behind locally-applied deltas.
		// Preserve the richer local string if it is a strict prefix extension
		// of the snapshot to avoid visible text regression while streaming.
		if (prevVal.length > nextVal.length && prevVal.startsWith(nextVal)) {
			nextRecord[field] = prevVal;
			mergedPositions[field] = Math.min(
				Math.max(prevPosRaw, 0),
				prevVal.length,
			);
			continue;
		}

		const currentPos = mergedPositions[field];
		const fallbackPos =
			typeof currentPos === "number" && Number.isFinite(currentPos)
				? currentPos
				: nextVal.length;
		mergedPositions[field] = Math.min(Math.max(fallbackPos, 0), nextVal.length);
	}

	nextRecord._deltaPositions = mergedPositions;
	return nextRecord as DeltaTrackedPart;
}

function applyStreamingDeltaToPart(
	existingPart: Part,
	field: string,
	delta: string,
): DeltaTrackedPart {
	const existingRecord = existingPart as Record<string, unknown>;
	const currentRaw = existingRecord[field];
	const currentVal = typeof currentRaw === "string" ? currentRaw : "";
	const positions =
		(existingRecord._deltaPositions as Record<string, number> | undefined) ??
		{};
	const rawDeltaPos = positions[field] ?? 0;
	const numericDeltaPos = Number.isFinite(rawDeltaPos) ? rawDeltaPos : 0;

	const existing: DeltaTrackedPart =
		typeof currentRaw === "string"
			? (existingPart as DeltaTrackedPart)
			: ({ ...existingPart, [field]: currentVal } as DeltaTrackedPart);

	if (numericDeltaPos > currentVal.length) {
		return {
			...existing,
			_deltaPositions: { ...positions, [field]: currentVal.length },
		};
	}

	const deltaPos = Math.max(0, numericDeltaPos);
	const nextPos = deltaPos + delta.length;

	if (nextPos <= currentVal.length) {
		const expected = currentVal.slice(deltaPos, nextPos);
		return {
			...existing,
			_deltaPositions: {
				...positions,
				[field]: expected === delta ? nextPos : currentVal.length,
			},
		};
	}

	const overlap = currentVal.length - deltaPos;
	if (overlap > 0) {
		const expectedOverlap = currentVal.slice(deltaPos);
		const deltaPrefix = delta.slice(0, overlap);
		if (expectedOverlap !== deltaPrefix) {
			return {
				...existing,
				_deltaPositions: { ...positions, [field]: currentVal.length },
			};
		}
	}

	const newText = delta.slice(Math.max(0, overlap));
	return {
		...existing,
		[field]: currentVal + newText,
		_deltaPositions: { ...positions, [field]: nextPos },
	};
}

function reducer(state: OpenCodeState, action: Action): OpenCodeState {
	switch (action.type) {
		case "SET_PROJECT_CONNECTION": {
			const { directory, status } = action.payload;
			return {
				...state,
				connections: { ...state.connections, [directory]: status },
			};
		}

		case "REMOVE_PROJECT": {
			const removedSessionIds = new Set(
				state.sessions
					.filter((s) => s.directory === action.payload)
					.map((s) => s.id),
			);
			const { [action.payload]: _, ...rest } = state.connections;
			const nextBusy = new Set(
				[...state.busySessionIds].filter((id) => !removedSessionIds.has(id)),
			);
			const nextPermissions: Record<string, PermissionRequest> = {};
			for (const [sid, value] of Object.entries(state.pendingPermissions)) {
				if (!removedSessionIds.has(sid)) nextPermissions[sid] = value;
			}
			const nextQuestions: Record<string, QuestionRequest> = {};
			for (const [sid, value] of Object.entries(state.pendingQuestions)) {
				if (!removedSessionIds.has(sid)) nextQuestions[sid] = value;
			}
			const nextQueues: Record<string, QueuedPrompt[]> = {};
			for (const [sid, value] of Object.entries(state.queuedPrompts)) {
				if (!removedSessionIds.has(sid)) nextQueues[sid] = value;
			}
			const nextBuffers: Record<
				string,
				Record<string, { info: Message; parts: Record<string, Part> }>
			> = {};
			for (const [sid, value] of Object.entries(state._sessionBuffers)) {
				if (!removedSessionIds.has(sid)) nextBuffers[sid] = value;
			}
			const nextUnread = new Set(
				[...state.unreadSessionIds].filter((id) => !removedSessionIds.has(id)),
			);
			return {
				...state,
				connections: rest,
				sessions: state.sessions.filter((s) => s.directory !== action.payload),
				busySessionIds: nextBusy,
				unreadSessionIds: nextUnread,
				pendingPermissions: nextPermissions,
				pendingQuestions: nextQuestions,
				queuedPrompts: nextQueues,
				_sessionBuffers: nextBuffers,
				...(state.activeSessionId &&
				removedSessionIds.has(state.activeSessionId)
					? { activeSessionId: null, messages: [], isBusy: false }
					: {}),
				// Clear draft if it belongs to the removed project
				draftSessionDirectory:
					state.draftSessionDirectory === action.payload
						? null
						: state.draftSessionDirectory,
			};
		}

		case "CLEAR_ALL_PROJECTS":
			return {
				...state,
				connections: {},
				sessions: [],
				activeSessionId: null,
				messages: [],
				isBusy: false,
				childSessions: {},
				trackedChildSessionIds: new Set(),
				_pendingSnapshots: [],
				_sessionBuffers: {},
				draftSessionDirectory: null,
			};

		case "SET_SESSIONS":
			return { ...state, sessions: sortSessionsNewestFirst(action.payload) };

		case "SET_BOOT_STATE": {
			return {
				...state,
				bootState: action.payload.state,
				bootError: action.payload.error ?? null,
			};
		}

		case "MERGE_PROJECT_SESSIONS": {
			const { directory, sessions } = action.payload;
			const scoped = sessions.filter((s) => s.directory === directory);
			const filtered = state.sessions.filter((s) => s.directory !== directory);
			return {
				...state,
				sessions: sortSessionsNewestFirst([...filtered, ...scoped]),
			};
		}

		case "SET_ACTIVE_SESSION": {
			const sid = action.payload;
			let startingBuffers = state._sessionBuffers;
			const previousSid = state.activeSessionId;
			if (
				previousSid &&
				previousSid !== sid &&
				state.messages.length > 0 &&
				state.busySessionIds.has(previousSid)
			) {
				const snapshot: Record<
					string,
					{ info: Message; parts: Record<string, Part> }
				> = {};
				for (const msg of state.messages) {
					const partsById: Record<string, Part> = {};
					for (const p of msg.parts) {
						partsById[p.id] = p;
					}
					snapshot[msg.info.id] = { info: msg.info, parts: partsById };
				}
				startingBuffers = { ...startingBuffers, [previousSid]: snapshot };
			}
			// If we have a buffer for this session, use it for instant display
			const buffered = sid ? startingBuffers[sid] : undefined;
			let initialMessages: MessageEntry[] = [];
			if (buffered) {
				initialMessages = Object.values(buffered).map((entry) => ({
					info: entry.info,
					parts: Object.values(entry.parts).map((p) => {
						const positions: Record<string, number> = {};
						for (const [key, value] of Object.entries(
							p as Record<string, unknown>,
						)) {
							if (typeof value === "string" && value.length > 0) {
								positions[key] = value.length;
							}
						}
						return { ...p, _deltaPositions: positions } as Part & {
							_deltaPositions: Record<string, number>;
						};
					}),
				}));
			}
			// Remove consumed buffer
			const { [sid ?? ""]: _consumed, ...remainingBuffers } = startingBuffers;
			// Clear unread flag for the session being viewed
			let nextUnread = state.unreadSessionIds;
			if (sid && state.unreadSessionIds.has(sid)) {
				nextUnread = new Set(state.unreadSessionIds);
				nextUnread.delete(sid);
			}
			return {
				...state,
				activeSessionId: sid,
				messages: initialMessages,
				isLoadingMessages: sid !== null,
				isBusy: sid ? state.busySessionIds.has(sid) : false,
				unreadSessionIds: nextUnread,
				// Selecting a real session clears any pending draft
				draftSessionDirectory: sid ? null : state.draftSessionDirectory,
				// Clear child session tracking when switching sessions
				childSessions: {},
				trackedChildSessionIds: new Set(),
				_pendingSnapshots: [],
				_sessionBuffers: buffered ? remainingBuffers : startingBuffers,
			};
		}

		case "SET_MESSAGES": {
			// Build a lookup of existing messages (may have been populated from
			// the session buffer + live deltas that arrived during the fetch).
			const existingByMsgId = new Map<string, MessageEntry>();
			for (const m of state.messages) {
				existingByMsgId.set(m.info.id, m);
			}

			// Initialise _deltaPositions on every part so that subsequent
			// PART_DELTA events append correctly instead of replaying from 0.
			// Merge with existing (buffer-populated) data: keep whichever part
			// has more text content (buffer/live may be ahead of the server).
			const taggedMessages = action.payload.map((m) => {
				const existing = existingByMsgId.get(m.info.id);
				const existingPartsById = new Map<string, Part>();
				if (existing) {
					for (const p of existing.parts) {
						existingPartsById.set(p.id, p);
					}
				}
				return {
					...m,
					parts: m.parts.map((p) => {
						const prev = existingPartsById.get(p.id);
						// If we already have this part with more content, keep it
						if (prev) {
							const prevText =
								((prev as Record<string, unknown>).text as string) ?? "";
							const newText =
								((p as Record<string, unknown>).text as string) ?? "";
							if (prevText.length >= newText.length) return prev;
						}
						if ((p as Record<string, unknown>)._deltaPositions) return p;
						const positions: Record<string, number> = {};
						for (const [key, value] of Object.entries(
							p as Record<string, unknown>,
						)) {
							if (typeof value === "string" && value.length > 0) {
								positions[key] = value.length;
							}
						}
						return { ...p, _deltaPositions: positions } as Part & {
							_deltaPositions: Record<string, number>;
						};
					}),
				};
			});

			// Include any messages present in state but not in server response
			// (e.g. a brand-new message that arrived via SSE during the fetch).
			for (const [id, entry] of existingByMsgId) {
				if (!action.payload.some((m) => m.info.id === id)) {
					taggedMessages.push(entry);
				}
			}

			// Replay any snapshot events that arrived while messages were loading.
			let replayedState: OpenCodeState = {
				...state,
				messages: taggedMessages,
				isLoadingMessages: false,
				_pendingSnapshots: [],
			};
			for (const event of state._pendingSnapshots) {
				replayedState = reducer(replayedState, event);
			}
			return replayedState;
		}

		case "SET_BUSY":
			return { ...state, isBusy: action.payload };

		case "SET_ERROR":
			return { ...state, lastError: action.payload };

		case "SET_PERMISSION": {
			const p = action.payload;
			if ("clear" in p) {
				const { [p.sessionID]: _, ...rest } = state.pendingPermissions;
				return { ...state, pendingPermissions: rest };
			}
			return {
				...state,
				pendingPermissions: { ...state.pendingPermissions, [p.sessionID]: p },
			};
		}

		case "SET_QUESTION": {
			const q = action.payload;
			if ("clear" in q) {
				const { [q.sessionID]: _, ...rest } = state.pendingQuestions;
				return { ...state, pendingQuestions: rest };
			}
			return {
				...state,
				pendingQuestions: { ...state.pendingQuestions, [q.sessionID]: q },
			};
		}

		case "SET_PROVIDERS":
			return {
				...state,
				providers: action.payload.providers,
				providerDefaults: action.payload.default,
			};

		case "SET_SELECTED_MODEL":
			return { ...state, selectedModel: action.payload };

		case "SET_AGENTS":
			return { ...state, agents: action.payload };

		case "SET_COMMANDS":
			return { ...state, commands: action.payload };

		case "SET_SELECTED_AGENT":
			return { ...state, selectedAgent: action.payload };

		case "SET_VARIANT_SELECTIONS":
			return { ...state, variantSelections: action.payload };

		case "SESSION_CREATED":
			// Ignore subagent / child sessions - only root sessions appear in the sidebar.
			if (action.payload.parentID) return state;
			if (!(action.payload.directory in state.connections)) return state;
			return {
				...state,
				sessions: sortSessionsNewestFirst([
					action.payload,
					...state.sessions.filter((s) => s.id !== action.payload.id),
				]),
			};

		case "SESSION_UPDATED": {
			const updated = action.payload;
			// Ignore subagent / child sessions - only root sessions appear in the sidebar.
			if (updated.parentID) return state;
			if (!(updated.directory in state.connections)) return state;
			const exists = state.sessions.some((s) => s.id === updated.id);
			// Update in-place without re-sorting to prevent the sidebar from
			// jumping around while sessions receive streaming updates.
			return {
				...state,
				sessions: exists
					? state.sessions.map((s) => (s.id === updated.id ? updated : s))
					: [updated, ...state.sessions],
			};
		}

		case "SESSION_DELETED": {
			const { [action.payload]: _deletedQueue, ...remainingQueues } =
				state.queuedPrompts;
			const { [action.payload]: _deletedBuffer, ...remainingBuffers } =
				state._sessionBuffers;
			const nextTemp = new Set(state.temporarySessions);
			nextTemp.delete(action.payload);
			const nextUnread = new Set(state.unreadSessionIds);
			nextUnread.delete(action.payload);
			return {
				...state,
				sessions: state.sessions.filter((s) => s.id !== action.payload),
				queuedPrompts: remainingQueues,
				_sessionBuffers: remainingBuffers,
				temporarySessions: nextTemp,
				unreadSessionIds: nextUnread,
				...(state.activeSessionId === action.payload
					? { activeSessionId: null, messages: [], isBusy: false }
					: {}),
			};
		}

		case "MESSAGE_UPDATED": {
			const msg = action.payload;
			if (msg.sessionID !== state.activeSessionId) {
				// Store child session messages for live subagent step display
				if (state.trackedChildSessionIds.has(msg.sessionID)) {
					const childBuf = { ...state.childSessions };
					const sessBuf = { ...(childBuf[msg.sessionID] ?? {}) };
					const entry = sessBuf[msg.id] ?? { info: msg, parts: {} };
					sessBuf[msg.id] = { ...entry, info: msg };
					childBuf[msg.sessionID] = sessBuf;
					return { ...state, childSessions: childBuf };
				}
				// Buffer snapshot for non-active sessions.
				// Do not gate on busySessionIds because event ordering is not guaranteed
				// (message updates can arrive before session.status=busy is observed).
				const buf = { ...state._sessionBuffers };
				const sessBuf = { ...(buf[msg.sessionID] ?? {}) };
				const entry = sessBuf[msg.id] ?? { info: msg, parts: {} };
				sessBuf[msg.id] = { ...entry, info: msg };
				buf[msg.sessionID] = sessBuf;
				return { ...state, _sessionBuffers: buf };
			}
			// Queue snapshot if messages are still loading from the server
			if (state.isLoadingMessages) {
				return {
					...state,
					_pendingSnapshots: [...state._pendingSnapshots, action],
				};
			}
			const exists = state.messages.some((m) => m.info.id === msg.id);

			// Sync selectedModel when a new assistant message arrives with model info
			let modelPatch: { selectedModel: SelectedModel } | undefined;
			if (
				msg.role === "assistant" &&
				"providerID" in msg &&
				"modelID" in msg &&
				msg.providerID &&
				msg.modelID
			) {
				const candidate: SelectedModel = {
					providerID: msg.providerID,
					modelID: msg.modelID,
				};
				if (
					findModel(state.providers, candidate.providerID, candidate.modelID)
				) {
					modelPatch = { selectedModel: candidate };
				}
			}

			// Sync selectedAgent when a new assistant message arrives
			let agentPatch: { selectedAgent: string | null } | undefined;
			if (msg.role === "assistant" && "agent" in msg && msg.agent) {
				const valid = state.agents.some(
					(a) =>
						a.name === msg.agent &&
						(a.mode === "primary" || a.mode === "all") &&
						!a.hidden,
				);
				if (valid) {
					agentPatch = {
						selectedAgent: msg.agent === "build" ? null : msg.agent,
					};
				}
			}

			// Sync variant when a new assistant message arrives
			let variantPatch: { variantSelections: VariantSelections } | undefined;
			if (
				msg.role === "assistant" &&
				"variant" in msg &&
				modelPatch?.selectedModel
			) {
				const key = variantKey(
					modelPatch.selectedModel.providerID,
					modelPatch.selectedModel.modelID,
				);
				const newSelections = { ...state.variantSelections };
				if (msg.variant) {
					newSelections[key] = msg.variant as string;
				} else {
					delete newSelections[key];
				}
				variantPatch = { variantSelections: newSelections };
			}

			if (exists) {
				return {
					...state,
					messages: state.messages.map((m) =>
						m.info.id === msg.id ? { ...m, info: msg } : m,
					),
					...modelPatch,
					...agentPatch,
					...variantPatch,
				};
			}
			return {
				...state,
				messages: [...state.messages, { info: msg, parts: [] }],
				...modelPatch,
				...agentPatch,
				...variantPatch,
			};
		}

		case "PART_UPDATED": {
			const { part } = action.payload;
			if (part.sessionID !== state.activeSessionId) {
				// Store child session parts for live subagent step display
				if (state.trackedChildSessionIds.has(part.sessionID)) {
					const childBuf = { ...state.childSessions };
					const sessBuf = { ...(childBuf[part.sessionID] ?? {}) };
					const entry = sessBuf[part.messageID] ?? {
						info: {
							id: part.messageID,
							sessionID: part.sessionID,
						} as Message,
						parts: {},
					};
					const newParts = { ...entry.parts, [part.id]: part };
					sessBuf[part.messageID] = { ...entry, parts: newParts };
					childBuf[part.sessionID] = sessBuf;
					return { ...state, childSessions: childBuf };
				}
				// Buffer snapshot for non-active sessions.
				// Do not gate on busySessionIds because event ordering is not guaranteed.
				const buf = { ...state._sessionBuffers };
				const sessBuf = { ...(buf[part.sessionID] ?? {}) };
				const entry = sessBuf[part.messageID] ?? {
					info: { id: part.messageID, sessionID: part.sessionID } as Message,
					parts: {},
				};
				const previous = entry.parts[part.id];
				const tagged = tagPartWithDeltaPositions(part, previous);
				const newParts = { ...entry.parts, [part.id]: tagged };
				sessBuf[part.messageID] = { ...entry, parts: newParts };
				buf[part.sessionID] = sessBuf;
				return { ...state, _sessionBuffers: buf };
			}
			// Track child session IDs from Task tool parts with metadata.sessionId
			let childTrackPatch:
				| {
						trackedChildSessionIds: Set<string>;
						childSessions: typeof state.childSessions;
				  }
				| undefined;
			if (
				part.type === "tool" &&
				part.tool.toLowerCase() === "task" &&
				"metadata" in part.state &&
				part.state.metadata
			) {
				const meta = part.state.metadata as Record<string, unknown>;
				const childSid =
					typeof meta.sessionId === "string" ? meta.sessionId : undefined;
				if (childSid && !state.trackedChildSessionIds.has(childSid)) {
					const nextTracked = new Set(state.trackedChildSessionIds);
					nextTracked.add(childSid);
					childTrackPatch = {
						trackedChildSessionIds: nextTracked,
						childSessions: {
							...state.childSessions,
							[childSid]: state.childSessions[childSid] ?? {},
						},
					};
				}
			}
			// Queue snapshot if messages are still loading from the server
			if (state.isLoadingMessages) {
				return {
					...state,
					...childTrackPatch,
					_pendingSnapshots: [...state._pendingSnapshots, action],
				};
			}

			const messageIndex = state.messages.findIndex(
				(m) => m.info.id === part.messageID,
			);
			const nextMessages = [...state.messages];
			if (messageIndex < 0) {
				nextMessages.push(
					createPlaceholderMessageEntry(part.sessionID, part.messageID),
				);
			}
			const resolvedMessageIndex =
				messageIndex >= 0 ? messageIndex : nextMessages.length - 1;
			const entry = nextMessages[resolvedMessageIndex];
			if (!entry) return state;

			const existingIdx = entry.parts.findIndex((p) => p.id === part.id);
			const previous = existingIdx >= 0 ? entry.parts[existingIdx] : undefined;
			const tagged = mergeSnapshotPartWithExisting(part, previous);
			const newParts = [...entry.parts];
			if (existingIdx >= 0) {
				newParts[existingIdx] = tagged;
			} else {
				newParts.push(tagged);
			}
			nextMessages[resolvedMessageIndex] = { ...entry, parts: newParts };

			return { ...state, ...childTrackPatch, messages: nextMessages };
		}

		case "PART_DELTA": {
			const { sessionID, messageID, partID, field, delta } = action.payload;
			if (sessionID !== state.activeSessionId) {
				// Apply deltas to tracked child sessions for live subagent display
				if (state.trackedChildSessionIds.has(sessionID)) {
					const childBuf = state.childSessions[sessionID] ?? {};
					const entry = childBuf[messageID] ?? {
						info: { id: messageID, sessionID } as Message,
						parts: {},
					};
					const existing =
						entry.parts[partID] ??
						createPlaceholderPart(sessionID, messageID, partID, field);
					const nextPart = applyStreamingDeltaToPart(existing, field, delta);
					return {
						...state,
						childSessions: {
							...state.childSessions,
							[sessionID]: {
								...childBuf,
								[messageID]: {
									...entry,
									parts: { ...entry.parts, [partID]: nextPart },
								},
							},
						},
					};
				}
				// Keep applying deltas for non-active sessions so switching back
				// can show the full in-progress stream.
				const sessionBuffer = state._sessionBuffers[sessionID] ?? {};
				const entry = sessionBuffer[messageID] ?? {
					info: { id: messageID, sessionID } as Message,
					parts: {},
				};
				const existing =
					entry.parts[partID] ??
					createPlaceholderPart(sessionID, messageID, partID, field);
				const nextPart = applyStreamingDeltaToPart(existing, field, delta);

				const newBuffers = {
					...state._sessionBuffers,
					[sessionID]: {
						...sessionBuffer,
						[messageID]: {
							...entry,
							parts: { ...entry.parts, [partID]: nextPart },
						},
					},
				};
				return { ...state, _sessionBuffers: newBuffers };
			}

			if (state.isLoadingMessages) {
				return {
					...state,
					_pendingSnapshots: [...state._pendingSnapshots, action],
				};
			}

			const messageIndex = state.messages.findIndex(
				(m) => m.info.id === messageID,
			);
			const nextMessages = [...state.messages];
			if (messageIndex < 0) {
				nextMessages.push(createPlaceholderMessageEntry(sessionID, messageID));
			}
			const resolvedMessageIndex =
				messageIndex >= 0 ? messageIndex : nextMessages.length - 1;
			const message = nextMessages[resolvedMessageIndex];
			if (!message) return state;

			const partIndex = message.parts.findIndex((p) => p.id === partID);
			const existing =
				partIndex >= 0
					? message.parts[partIndex]
					: createPlaceholderPart(sessionID, messageID, partID, field);
			if (!existing) return state;

			const nextPart = applyStreamingDeltaToPart(existing, field, delta);
			const nextParts = [...message.parts];
			if (partIndex >= 0) {
				nextParts[partIndex] = nextPart;
			} else {
				nextParts.push(nextPart);
			}

			nextMessages[resolvedMessageIndex] = { ...message, parts: nextParts };
			return { ...state, messages: nextMessages };
		}

		case "PART_REMOVED": {
			const { sessionID, messageID, partID } = action.payload;
			if (sessionID === state.activeSessionId && state.isLoadingMessages) {
				return {
					...state,
					_pendingSnapshots: [...state._pendingSnapshots, action],
				};
			}
			if (sessionID !== state.activeSessionId) {
				// Handle removal for tracked child sessions
				if (state.trackedChildSessionIds.has(sessionID)) {
					const childBuf = state.childSessions[sessionID];
					if (!childBuf) return state;
					const entry = childBuf[messageID];
					if (!entry || !(partID in entry.parts)) return state;
					const { [partID]: _removedChild, ...remainingChildParts } =
						entry.parts;
					return {
						...state,
						childSessions: {
							...state.childSessions,
							[sessionID]: {
								...childBuf,
								[messageID]: {
									...entry,
									parts: remainingChildParts,
								},
							},
						},
					};
				}
				const sessionBuffer = state._sessionBuffers[sessionID];
				if (!sessionBuffer) return state;
				const entry = sessionBuffer[messageID];
				if (!entry || !(partID in entry.parts)) return state;
				const { [partID]: _removed, ...remainingParts } = entry.parts;
				const newBuffers = { ...state._sessionBuffers };
				newBuffers[sessionID] = {
					...sessionBuffer,
					[messageID]: { ...entry, parts: remainingParts },
				};
				return { ...state, _sessionBuffers: newBuffers };
			}
			return {
				...state,
				messages: state.messages.map((m) => {
					if (m.info.id !== messageID) return m;
					return {
						...m,
						parts: m.parts.filter((p) => p.id !== partID),
					};
				}),
			};
		}

		case "SESSION_STATUS": {
			const { sessionID, status } = action.payload;
			const isBusy = status.type === "busy";
			const newBusy = new Set(state.busySessionIds);
			if (isBusy) {
				newBusy.add(sessionID);
			} else {
				newBusy.delete(sessionID);
			}
			// Clean up session buffer when session goes idle
			let nextBuffers = state._sessionBuffers;
			if (!isBusy && sessionID in state._sessionBuffers) {
				const { [sessionID]: _, ...rest } = state._sessionBuffers;
				nextBuffers = rest;
			}
			// Mark session as unread when it finishes generating (busy -> idle)
			// and the user is not currently viewing it
			let nextUnread = state.unreadSessionIds;
			if (
				!isBusy &&
				state.busySessionIds.has(sessionID) &&
				sessionID !== state.activeSessionId
			) {
				nextUnread = new Set(state.unreadSessionIds);
				nextUnread.add(sessionID);
			}
			return {
				...state,
				busySessionIds: newBusy,
				unreadSessionIds: nextUnread,
				_sessionBuffers: nextBuffers,
				...(sessionID === state.activeSessionId ? { isBusy } : {}),
			};
		}

		case "INIT_BUSY_SESSIONS": {
			const statuses = action.payload as Record<string, { type: string }>;
			const newBusy = new Set(state.busySessionIds);
			let nextBuffers = state._sessionBuffers;
			for (const [sessionID, status] of Object.entries(statuses)) {
				if (status.type === "busy") {
					newBusy.add(sessionID);
				} else {
					newBusy.delete(sessionID);
					if (sessionID in nextBuffers) {
						const { [sessionID]: _removed, ...rest } = nextBuffers;
						nextBuffers = rest;
					}
				}
			}
			return {
				...state,
				busySessionIds: newBusy,
				_sessionBuffers: nextBuffers,
				...(state.activeSessionId && statuses[state.activeSessionId]
					? {
							isBusy: statuses[state.activeSessionId]?.type === "busy",
						}
					: {}),
			};
		}

		case "QUEUE_ADD": {
			const { sessionID, prompt } = action.payload;
			const existing = state.queuedPrompts[sessionID] ?? [];
			return {
				...state,
				queuedPrompts: {
					...state.queuedPrompts,
					[sessionID]: [...existing, prompt],
				},
			};
		}

		case "QUEUE_SHIFT": {
			const { sessionID } = action.payload;
			const existing = state.queuedPrompts[sessionID] ?? [];
			if (existing.length <= 1) {
				const { [sessionID]: _, ...rest } = state.queuedPrompts;
				return { ...state, queuedPrompts: rest };
			}
			return {
				...state,
				queuedPrompts: {
					...state.queuedPrompts,
					[sessionID]: existing.slice(1),
				},
			};
		}

		case "QUEUE_REMOVE": {
			const { sessionID, promptID } = action.payload;
			const existing = state.queuedPrompts[sessionID] ?? [];
			if (existing.length === 0) return state;
			const next = existing.filter((item) => item.id !== promptID);
			if (next.length === existing.length) return state;
			if (next.length === 0) {
				const { [sessionID]: _, ...rest } = state.queuedPrompts;
				return { ...state, queuedPrompts: rest };
			}
			return {
				...state,
				queuedPrompts: {
					...state.queuedPrompts,
					[sessionID]: next,
				},
			};
		}

		case "QUEUE_REORDER": {
			const { sessionID, fromIndex, toIndex } = action.payload;
			const existing = state.queuedPrompts[sessionID] ?? [];
			if (existing.length <= 1) return state;
			if (fromIndex < 0 || fromIndex >= existing.length) return state;

			const clampedTo = Math.max(0, Math.min(toIndex, existing.length - 1));
			if (clampedTo === fromIndex) return state;

			const next = [...existing];
			const [moved] = next.splice(fromIndex, 1);
			if (!moved) return state;
			next.splice(clampedTo, 0, moved);

			return {
				...state,
				queuedPrompts: {
					...state.queuedPrompts,
					[sessionID]: next,
				},
			};
		}

		case "QUEUE_UPDATE": {
			const { sessionID, promptID, text } = action.payload;
			const existing = state.queuedPrompts[sessionID] ?? [];
			if (existing.length === 0) return state;

			let changed = false;
			const next = existing.map((item) => {
				if (item.id !== promptID) return item;
				if (item.text === text) return item;
				changed = true;
				return { ...item, text };
			});

			if (!changed) return state;
			return {
				...state,
				queuedPrompts: {
					...state.queuedPrompts,
					[sessionID]: next,
				},
			};
		}

		case "QUEUE_CLEAR": {
			const { sessionID } = action.payload;
			const { [sessionID]: _, ...rest } = state.queuedPrompts;
			return { ...state, queuedPrompts: rest };
		}

		case "SET_RECENT_PROJECTS":
			return { ...state, recentProjects: action.payload };

		case "START_DRAFT_SESSION":
			return {
				...state,
				draftSessionDirectory: action.payload,
				activeSessionId: null,
				messages: [],
				isBusy: false,
			};

		case "CLEAR_DRAFT_SESSION":
			return { ...state, draftSessionDirectory: null, draftIsTemporary: false };

		case "SET_DRAFT_TEMPORARY":
			return { ...state, draftIsTemporary: action.payload };

		case "MARK_SESSION_TEMPORARY": {
			const next = new Set(state.temporarySessions);
			next.add(action.payload);
			return { ...state, temporarySessions: next };
		}

		case "UNMARK_SESSION_TEMPORARY": {
			const next = new Set(state.temporarySessions);
			next.delete(action.payload);
			return { ...state, temporarySessions: next };
		}

		case "SET_SESSION_META": {
			const { sessionId, meta } = action.payload;
			const nextMeta = { ...state.sessionMeta };
			const existing = nextMeta[sessionId] ?? {};
			nextMeta[sessionId] = { ...existing, ...meta };
			persistSessionMetaMap(nextMeta);
			return { ...state, sessionMeta: nextMeta };
		}

		case "REGISTER_WORKTREE": {
			const { worktreeDir, parentDir } = action.payload;
			const next = { ...state.worktreeParents, [worktreeDir]: parentDir };
			persistWorktreeParents(next);
			return { ...state, worktreeParents: next };
		}

		case "UNREGISTER_WORKTREE": {
			const next = { ...state.worktreeParents };
			delete next[action.payload];
			persistWorktreeParents(next);
			return { ...state, worktreeParents: next };
		}

		case "LOAD_CHILD_SESSION": {
			const { childSessionId, messages } = action.payload;
			const childBuf: Record<
				string,
				{ info: Message; parts: Record<string, Part> }
			> = {};
			for (const msg of messages) {
				const partsById: Record<string, Part> = {};
				for (const p of msg.parts) {
					partsById[p.id] = p;
				}
				childBuf[msg.info.id] = { info: msg.info, parts: partsById };
			}
			const nextTracked = new Set(state.trackedChildSessionIds);
			nextTracked.add(childSessionId);
			return {
				...state,
				trackedChildSessionIds: nextTracked,
				childSessions: {
					...state.childSessions,
					[childSessionId]: childBuf,
				},
			};
		}

		default:
			return state;
	}
}

// ---------------------------------------------------------------------------
// Child session helpers
// ---------------------------------------------------------------------------

/** Collect all ToolPart objects from a child (subagent) session's stored data. */
export function getChildSessionToolParts(
	childSessions: OpenCodeState["childSessions"],
	childSessionId: string,
): Part[] {
	const child = childSessions[childSessionId];
	if (!child) return [];
	return Object.values(child)
		.flatMap((m) => Object.values(m.parts))
		.filter((p) => p.type === "tool");
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface OpenCodeContextValue {
	state: OpenCodeState;
	/** Add a project (connects to server with directory scope). Additive. */
	addProject: (
		config: ConnectionConfig,
		options?: { suppressError?: boolean },
	) => Promise<void>;
	/** Remove a project (disconnects its connection). */
	removeProject: (directory: string) => Promise<void>;
	/** Disconnect ALL projects. */
	disconnect: () => Promise<void>;
	selectSession: (id: string | null) => Promise<void>;
	createSession: (
		title?: string,
		directory?: string,
	) => Promise<Session | null>;
	deleteSession: (id: string) => Promise<void>;
	renameSession: (id: string, title: string) => Promise<void>;
	sendPrompt: (text: string, images?: string[]) => Promise<void>;
	sendCommand: (command: string, args: string) => Promise<void>;
	abortSession: () => Promise<void>;
	respondPermission: (response: "once" | "always" | "reject") => Promise<void>;
	replyQuestion: (answers: QuestionAnswer[]) => Promise<void>;
	rejectQuestion: () => Promise<void>;
	setModel: (model: SelectedModel | null) => void;
	setAgent: (agent: string | null) => void;
	/** Cycle the variant for the currently selected model */
	cycleVariant: () => void;
	/** Set variant explicitly for the currently selected model */
	setVariant: (variant: string | undefined) => void;
	/** Get the currently effective variant */
	currentVariant: string | undefined;
	clearError: () => void;
	/** Re-fetch providers from the server (e.g. after connecting/disconnecting a provider). */
	refreshProviders: () => Promise<void>;
	refreshSessions: () => Promise<void>;
	/** Get queued prompts for a session */
	getQueuedPrompts: (sessionId: string) => QueuedPrompt[];
	/** Remove one queued prompt by ID */
	removeFromQueue: (sessionId: string, promptId: string) => void;
	/** Reorder one queued prompt by indexes */
	reorderQueue: (sessionId: string, fromIndex: number, toIndex: number) => void;
	/** Update queued prompt text by ID */
	updateQueuedPrompt: (
		sessionId: string,
		promptId: string,
		text: string,
	) => void;
	/** Send one queued prompt immediately; aborts current run if needed */
	sendQueuedNow: (sessionId: string, promptId: string) => Promise<void>;
	/** Open native directory picker, returns path or null */
	openDirectory: () => Promise<string | null>;
	/** Connect to a project directory (convenience wrapper for addProject) */
	connectToProject: (directory: string, serverUrl?: string) => Promise<void>;
	/** Start a draft session for a directory (no API call until first send) */
	startDraftSession: (directory: string) => void;
	/** Toggle whether the current draft session should be temporary */
	setDraftTemporary: (temporary: boolean) => void;
	/** Revert the active session to a specific message (undo). */
	revertToMessage: (messageID: string) => Promise<void>;
	/** Restore all reverted messages in the active session (redo all). */
	unrevert: () => Promise<void>;
	/** Fork the active session at a specific message, creating a new session. */
	forkFromMessage: (messageID: string) => Promise<void>;
	/** Set the color for a session (local-only, stored in localStorage). */
	setSessionColor: (sessionId: string, color: SessionColor) => void;
	/** Set tags for a session (local-only, stored in localStorage). */
	setSessionTags: (sessionId: string, tags: string[]) => void;
	/** Register a worktree directory as belonging to a parent project. */
	registerWorktree: (worktreeDir: string, parentDir: string) => void;
	/** Unregister a worktree directory. */
	unregisterWorktree: (worktreeDir: string) => void;
}

const OpenCodeContext = createContext<OpenCodeContextValue | null>(null);

// ---------------------------------------------------------------------------
// Helpers: find model in providers
// ---------------------------------------------------------------------------

import { findModel } from "@/lib/utils";

/**
 * Extract the model used in the last assistant message.
 * Returns null if no assistant message with model info is found.
 */
function extractModelFromMessages(
	messages: MessageEntry[],
	providers: Provider[],
): SelectedModel | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]?.info;
		if (
			msg?.role === "assistant" &&
			"providerID" in msg &&
			"modelID" in msg &&
			msg.providerID &&
			msg.modelID
		) {
			const candidate: SelectedModel = {
				providerID: msg.providerID,
				modelID: msg.modelID,
			};
			// Only return if the model still exists in available providers
			if (findModel(providers, candidate.providerID, candidate.modelID)) {
				return candidate;
			}
		}
	}
	return null;
}

/**
 * Walk messages backward and return the agent name from the last assistant
 * message whose agent still exists and is selectable.
 * Returns `null` when the agent is the default ("build") or not found.
 */
function extractAgentFromMessages(
	messages: MessageEntry[],
	agents: Agent[],
): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]?.info;
		if (msg?.role === "assistant" && "agent" in msg && msg.agent) {
			const exists = agents.some(
				(a) =>
					a.name === msg.agent &&
					(a.mode === "primary" || a.mode === "all") &&
					!a.hidden,
			);
			if (exists) {
				return msg.agent === "build" ? null : msg.agent;
			}
		}
	}
	return null;
}

/**
 * Walk messages backward and return the variant string from the last
 * assistant message that carried one. Returns `undefined` when not found.
 */
function extractVariantFromMessages(
	messages: MessageEntry[],
): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]?.info;
		if (msg?.role === "assistant" && "variant" in msg && msg.variant) {
			return msg.variant as string;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function OpenCodeProvider({ children }: { children: ReactNode }) {
	const [state, dispatch] = useReducer(reducer, initialState);

	const bridge = useMemo(() => window.electronAPI?.opencode, []);
	const expectedDirectoriesRef = useRef<Set<string>>(new Set());

	// Keep refs so selectSession can read current values without stale closures
	const providersRef = useRef(state.providers);
	providersRef.current = state.providers;
	const agentsRef = useRef(state.agents);
	agentsRef.current = state.agents;
	const variantSelectionsRef = useRef(state.variantSelections);
	variantSelectionsRef.current = state.variantSelections;
	const selectedModelRef = useRef(state.selectedModel);
	selectedModelRef.current = state.selectedModel;
	const selectedAgentRef = useRef(state.selectedAgent);
	selectedAgentRef.current = state.selectedAgent;
	const selectSessionRequestRef = useRef(0);

	// --- SSE event handler ---
	const handleBridgeEvent = useCallback((event: BridgeEvent) => {
		if (!expectedDirectoriesRef.current.has(event.directory)) {
			return;
		}
		if (event.type === "connection:status") {
			dispatch({
				type: "SET_PROJECT_CONNECTION",
				payload: { directory: event.directory, status: event.payload },
			});
			return;
		}

		if (event.type === "opencode:event") {
			const oc = event.payload as OpenCodeEvent;
			switch (oc.type) {
				case "session.created":
					if (oc.properties.info.directory !== event.directory) return;
					dispatch({ type: "SESSION_CREATED", payload: oc.properties.info });
					break;
				case "session.updated":
					if (oc.properties.info.directory !== event.directory) return;
					dispatch({ type: "SESSION_UPDATED", payload: oc.properties.info });
					break;
				case "session.deleted":
					dispatch({ type: "SESSION_DELETED", payload: oc.properties.info.id });
					break;
				case "message.updated":
					dispatch({ type: "MESSAGE_UPDATED", payload: oc.properties.info });
					break;
				case "message.part.updated":
					dispatch({
						type: "PART_UPDATED",
						payload: { part: oc.properties.part },
					});
					break;
				case "message.part.delta":
					dispatch({
						type: "PART_DELTA",
						payload: {
							sessionID: oc.properties.sessionID,
							messageID: oc.properties.messageID,
							partID: oc.properties.partID,
							field: oc.properties.field,
							delta: oc.properties.delta,
						},
					});
					break;
				case "message.part.removed":
					dispatch({
						type: "PART_REMOVED",
						payload: {
							sessionID: oc.properties.sessionID,
							messageID: oc.properties.messageID,
							partID: oc.properties.partID,
						},
					});
					break;
				case "session.status":
					dispatch({
						type: "SESSION_STATUS",
						payload: {
							sessionID: oc.properties.sessionID,
							status: oc.properties.status,
						},
					});
					break;
				// v2: permission.asked (was permission.updated in v1)
				case "permission.asked":
					dispatch({
						type: "SET_PERMISSION",
						payload: oc.properties as unknown as PermissionRequest,
					});
					break;
				case "permission.replied":
					dispatch({
						type: "SET_PERMISSION",
						payload: {
							sessionID: (oc.properties as { sessionID: string }).sessionID,
							clear: true,
						},
					});
					break;
				case "question.asked":
					dispatch({
						type: "SET_QUESTION",
						payload: oc.properties as unknown as QuestionRequest,
					});
					break;
				case "question.replied":
				case "question.rejected":
					dispatch({
						type: "SET_QUESTION",
						payload: {
							sessionID: (oc.properties as { sessionID: string }).sessionID,
							clear: true,
						},
					});
					break;
				case "session.error":
					if (oc.properties.error) {
						const errData = oc.properties.error;
						const errMsg =
							"data" in errData &&
							errData.data &&
							typeof errData.data === "object" &&
							"message" in errData.data
								? String((errData.data as { message: string }).message)
								: errData.name;
						dispatch({ type: "SET_ERROR", payload: errMsg });
					}
					break;
			}
		}
	}, []);

	// Subscribe to bridge events.
	// Use a ref guard to prevent duplicate subscriptions that can occur
	// when React StrictMode double-mounts effects, which would cause every
	// streaming delta to be dispatched twice and produce garbled/doubled text.
	const subscribedRef = useRef(false);
	useEffect(() => {
		if (!bridge || subscribedRef.current) return;
		subscribedRef.current = true;
		const unsub = bridge.onEvent(handleBridgeEvent);
		return () => {
			unsub();
			subscribedRef.current = false;
		};
	}, [bridge, handleBridgeEvent]);

	// Persist selectedModel to localStorage whenever it changes (covers
	// both explicit setModel calls and implicit updates from the reducer,
	// e.g. when switching sessions or receiving a new assistant message).
	// The ref guards against the initial render (selectedModel = null) wiping
	// the saved value before bootstrap has a chance to restore it.
	const modelInitialized = useRef(false);
	useEffect(() => {
		try {
			if (state.selectedModel) {
				modelInitialized.current = true;
				localStorage.setItem(
					"opencode:selectedModel",
					JSON.stringify(state.selectedModel),
				);
			} else if (modelInitialized.current) {
				localStorage.removeItem("opencode:selectedModel");
			}
		} catch {
			/* ignore */
		}
	}, [state.selectedModel]);

	// Persist unreadSessionIds to localStorage whenever it changes
	useEffect(() => {
		persistUnreadSessionIds(state.unreadSessionIds);
	}, [state.unreadSessionIds]);

	// Request notification permission on startup
	useEffect(() => {
		if (
			typeof Notification !== "undefined" &&
			Notification.permission === "default"
		) {
			Notification.requestPermission();
		}
	}, []);

	// --- Computed: current variant ---
	const currentVariant = useMemo(
		() =>
			resolveVariant(
				state.selectedModel,
				state.variantSelections,
				state.agents,
				state.selectedAgent,
			),
		[
			state.selectedModel,
			state.variantSelections,
			state.agents,
			state.selectedAgent,
		],
	);

	// --- Actions ---

	/** Whether providers/agents have been loaded from the server yet. */
	const globalDataLoaded = useRef(false);

	const addProject = useCallback(
		async (config: ConnectionConfig, options?: { suppressError?: boolean }) => {
			if (!bridge || !config.directory) return;
			expectedDirectoriesRef.current.add(config.directory);
			if (!options?.suppressError) {
				dispatch({ type: "SET_ERROR", payload: null });
			}
			const res = await bridge.addProject(config);
			if (!res.success) {
				expectedDirectoriesRef.current.delete(config.directory);
				if (!options?.suppressError) {
					dispatch({
						type: "SET_ERROR",
						payload: res.error ?? "Connection failed",
					});
				}
				return;
			}
			// Load sessions for this project
			const sessRes = await bridge.listSessions(config.directory);
			if (sessRes.success && sessRes.data) {
				const scopedSessions = sessRes.data.filter(
					(s) => s.directory === config.directory,
				);
				dispatch({
					type: "MERGE_PROJECT_SESSIONS",
					payload: { directory: config.directory, sessions: scopedSessions },
				});
			}
			// Fetch current session statuses to restore busy spinners
			try {
				const statusRes = await bridge.getSessionStatuses(config.directory);
				if (statusRes.success && statusRes.data) {
					dispatch({
						type: "INIT_BUSY_SESSIONS",
						payload: statusRes.data,
					});
				}
			} catch {
				/* ignore – spinner will appear on next SSE event */
			}
			// Load providers + agents once (they're global / same across projects)
			if (!globalDataLoaded.current) {
				const [provRes, agentRes, cmdRes] = await Promise.all([
					bridge.getProviders(),
					bridge.getAgents(),
					bridge.getCommands(),
				]);
				// Only mark as loaded if at least providers resolved, so a
				// transient failure does not permanently skip future load attempts.
				globalDataLoaded.current = !!(provRes.success && provRes.data);
				if (provRes.success && provRes.data) {
					dispatch({ type: "SET_PROVIDERS", payload: provRes.data });
					// Restore model from localStorage, fall back to provider defaults
					let restoredSelection = false;
					try {
						const saved = localStorage.getItem("opencode:selectedModel");
						if (saved) {
							const parsed = JSON.parse(saved) as SelectedModel;
							const prov = provRes.data.providers.find(
								(p: Provider) => p.id === parsed.providerID,
							);
							if (prov && parsed.modelID in prov.models) {
								dispatch({
									type: "SET_SELECTED_MODEL",
									payload: parsed,
								});
								restoredSelection = true;
							}
						}
					} catch {
						/* ignore */
					}
					if (!restoredSelection) {
						const fallback = resolveServerDefaultModel(
							provRes.data.providers,
							provRes.data.default,
						);
						if (fallback) {
							dispatch({
								type: "SET_SELECTED_MODEL",
								payload: fallback,
							});
						}
					}
					try {
						const saved = localStorage.getItem("opencode:variantSelections");
						if (saved) {
							const parsed = JSON.parse(saved) as VariantSelections;
							dispatch({
								type: "SET_VARIANT_SELECTIONS",
								payload: parsed,
							});
						}
					} catch {
						/* ignore */
					}
				}
				if (agentRes.success && agentRes.data) {
					dispatch({ type: "SET_AGENTS", payload: agentRes.data });
					try {
						const saved = localStorage.getItem("opencode:selectedAgent");
						if (saved) {
							const exists = agentRes.data.some((a: Agent) => a.name === saved);
							if (exists) {
								dispatch({
									type: "SET_SELECTED_AGENT",
									payload: saved,
								});
							}
						}
					} catch {
						/* ignore */
					}
				}
				if (cmdRes.success && cmdRes.data) {
					dispatch({ type: "SET_COMMANDS", payload: cmdRes.data });
				}
			}
			// Persist connection info
			try {
				localStorage.setItem("opencode:serverUrl", config.baseUrl);
				localStorage.setItem("opencode:directory", config.directory);
				if (config.username) {
					localStorage.setItem("opencode:username", config.username);
				} else {
					localStorage.removeItem("opencode:username");
				}
			} catch {
				/* ignore */
			}
			// Update recent projects
			if (config.directory) {
				const updated = addRecentProject({
					directory: config.directory,
					serverUrl: config.baseUrl,
					username: config.username,
					lastConnected: Date.now(),
				});
				upsertOpenProject({
					directory: config.directory,
					serverUrl: config.baseUrl,
					username: config.username,
					lastConnected: Date.now(),
				});
				dispatch({ type: "SET_RECENT_PROJECTS", payload: updated });
			}
		},
		[bridge],
	);

	const removeProject = useCallback(
		async (directory: string) => {
			if (!bridge) return;
			expectedDirectoriesRef.current.delete(directory);
			await bridge.removeProject(directory);
			removeOpenProject(directory);
			dispatch({ type: "REMOVE_PROJECT", payload: directory });
			// If the active session belongs to this project, clear it
			const activeSession = state.sessions.find(
				(s) => s.id === state.activeSessionId,
			);
			if (activeSession?.directory === directory) {
				dispatch({ type: "SET_ACTIVE_SESSION", payload: null });
			}
		},
		[bridge, state.sessions, state.activeSessionId],
	);

	// --- Startup bootstrap: ensure local server, then auto-connect open projects ---
	const startupAttempted = useRef(false);
	useEffect(() => {
		if (!bridge || startupAttempted.current) return;
		startupAttempted.current = true;
		let cancelled = false;

		const bootstrap = async () => {
			const opencodeBridge = window.electronAPI?.opencode;
			if (!opencodeBridge) {
				dispatch({ type: "SET_BOOT_STATE", payload: { state: "ready" } });
				return;
			}

			const shouldEnsureLocalServer = isLocalServer();
			if (shouldEnsureLocalServer) {
				dispatch({
					type: "SET_BOOT_STATE",
					payload: { state: "checking-server" },
				});

				const statusRes = await opencodeBridge.getServerStatus();
				if (!statusRes.success) {
					if (cancelled) return;
					dispatch({
						type: "SET_BOOT_STATE",
						payload: {
							state: "error",
							error: statusRes.error ?? "Failed to check local server status",
						},
					});
					return;
				}

				if (!statusRes.data?.running) {
					dispatch({
						type: "SET_BOOT_STATE",
						payload: { state: "starting-server" },
					});
					const startRes = await opencodeBridge.startServer();
					if (!startRes.success) {
						if (cancelled) return;
						dispatch({
							type: "SET_BOOT_STATE",
							payload: {
								state: "error",
								error: startRes.error ?? "Failed to start local server",
							},
						});
						return;
					}
				}
			}

			if (cancelled) return;
			dispatch({ type: "SET_ERROR", payload: null });
			try {
				const projects = getOpenProjects();
				expectedDirectoriesRef.current = new Set(
					projects.map((project) => project.directory),
				);
				await Promise.allSettled(
					projects.map((project) =>
						addProject(
							{
								baseUrl: project.serverUrl,
								directory: project.directory,
								username: project.username,
							},
							{ suppressError: true },
						),
					),
				);
			} catch {
				/* ignore localStorage errors */
			}

			if (cancelled) return;
			dispatch({ type: "SET_BOOT_STATE", payload: { state: "ready" } });
		};

		bootstrap();

		return () => {
			cancelled = true;
		};
	}, [bridge, addProject]);

	const disconnect = useCallback(async () => {
		if (!bridge) return;
		await bridge.disconnect();
		expectedDirectoriesRef.current.clear();
		clearOpenProjects();
		globalDataLoaded.current = false;
		dispatch({ type: "CLEAR_ALL_PROJECTS" });
	}, [bridge]);

	const openDirectory = useCallback(async (): Promise<string | null> => {
		// Use native Electron dialog only when available AND server is local.
		// Otherwise fall back to a simple text prompt (works in browsers and
		// when the opencode server is on a remote machine).
		if (window.electronAPI?.openDirectory && isLocalServer()) {
			return window.electronAPI.openDirectory();
		}
		const dir = window.prompt("Enter the project directory path:");
		return dir?.trim() || null;
	}, []);

	const connectToProject = useCallback(
		async (directory: string, serverUrl?: string) => {
			const url =
				serverUrl ??
				localStorage.getItem("opencode:serverUrl") ??
				"http://127.0.0.1:4096";
			const username = localStorage.getItem("opencode:username") ?? undefined;
			await addProject({
				baseUrl: url,
				directory,
				username: username || undefined,
			});
		},
		[addProject],
	);

	const refreshSessions = useCallback(async () => {
		if (!bridge) return;
		const res = await bridge.listSessions();
		if (res.success && res.data) {
			dispatch({ type: "SET_SESSIONS", payload: res.data });
		}
	}, [bridge]);

	// Ref to avoid stale closures in selectSession for temporary session cleanup
	const temporarySessionsRef = useRef(state.temporarySessions);
	temporarySessionsRef.current = state.temporarySessions;
	const activeSessionIdRef = useRef(state.activeSessionId);
	activeSessionIdRef.current = state.activeSessionId;
	const busySessionIdsRef = useRef(state.busySessionIds);
	busySessionIdsRef.current = state.busySessionIds;

	const selectSession = useCallback(
		async (id: string | null) => {
			// Auto-delete the previous session if it was temporary
			const prevId = activeSessionIdRef.current;
			if (prevId && prevId !== id && temporarySessionsRef.current.has(prevId)) {
				dispatch({ type: "SESSION_DELETED", payload: prevId });
				bridge?.deleteSession(prevId).catch(() => {
					/* best-effort cleanup of temporary session */
				});
			}

			const requestId = ++selectSessionRequestRef.current;
			dispatch({ type: "SET_ACTIVE_SESSION", payload: id });
			if (!id || !bridge) return;
			const res = await bridge.getMessages(id);
			if (requestId !== selectSessionRequestRef.current) return;
			const messages = res.success && res.data ? res.data : [];
			dispatch({ type: "SET_MESSAGES", payload: messages });

			// Fetch child session data for any task tool parts with metadata.sessionId
			if (messages.length > 0) {
				const childSessionIds = new Set<string>();
				for (const msg of messages) {
					for (const part of msg.parts) {
						if (part.type !== "tool") continue;
						if (part.tool.toLowerCase() !== "task") continue;
						const meta =
							"metadata" in part.state && part.state.metadata
								? (part.state.metadata as Record<string, unknown>)
								: null;
						if (meta && typeof meta.sessionId === "string") {
							childSessionIds.add(meta.sessionId);
						}
					}
				}
				// Fetch each child session's messages in parallel (fire-and-forget)
				for (const childSid of childSessionIds) {
					bridge.getMessages(childSid).then((childRes) => {
						if (requestId !== selectSessionRequestRef.current) return;
						if (childRes.success && childRes.data) {
							dispatch({
								type: "LOAD_CHILD_SESSION",
								payload: {
									childSessionId: childSid,
									messages: childRes.data,
								},
							});
						}
					});
				}
			}

			// For sessions with history, sync model/agent/variant from server data.
			// For empty (new) sessions, reset agent to default but keep the model.
			if (messages.length > 0) {
				// Sync model
				const sessionModel = extractModelFromMessages(
					messages,
					providersRef.current,
				);
				if (sessionModel) {
					dispatch({ type: "SET_SELECTED_MODEL", payload: sessionModel });
				}

				// Sync agent
				const sessionAgent = extractAgentFromMessages(
					messages,
					agentsRef.current,
				);
				dispatch({ type: "SET_SELECTED_AGENT", payload: sessionAgent });

				// Sync variant
				if (sessionModel) {
					const sessionVariant = extractVariantFromMessages(messages);
					const key = variantKey(sessionModel.providerID, sessionModel.modelID);
					const newSelections = {
						...variantSelectionsRef.current,
					};
					if (sessionVariant) {
						newSelections[key] = sessionVariant;
					} else {
						delete newSelections[key];
					}
					dispatch({
						type: "SET_VARIANT_SELECTIONS",
						payload: newSelections,
					});
				}
			} else {
				// New/empty session: reset agent to default, keep model
				dispatch({ type: "SET_SELECTED_AGENT", payload: null });
			}
		},
		[bridge],
	);

	const createSession = useCallback(
		async (title?: string, directory?: string): Promise<Session | null> => {
			if (!bridge) return null;
			const res = await bridge.createSession(title, directory);
			if (res.success && res.data) {
				await selectSession(res.data.id);
				return res.data;
			}
			dispatch({
				type: "SET_ERROR",
				payload: res.error ?? "Failed to create session",
			});
			return null;
		},
		[bridge, selectSession],
	);

	const deleteSession = useCallback(
		async (id: string) => {
			if (!bridge) return;
			// Auto-select adjacent session if deleting the active one
			if (state.activeSessionId === id) {
				const idx = state.sessions.findIndex((s) => s.id === id);
				const next = state.sessions[idx + 1] ?? state.sessions[idx - 1] ?? null;
				if (next) {
					selectSession(next.id);
				}
			}
			// Optimistic removal - don't wait for SSE round-trip
			dispatch({ type: "SESSION_DELETED", payload: id });
			bridge.deleteSession(id).catch(() => {
				/* best-effort deletion */
			});
		},
		[bridge, state.activeSessionId, state.sessions, selectSession],
	);

	const renameSession = useCallback(
		async (id: string, title: string) => {
			if (!bridge) return;
			const trimmed = title.trim();
			if (!trimmed) return;
			bridge.updateSession(id, trimmed).catch(() => {
				/* best-effort rename – SSE will reconcile */
			});
		},
		[bridge],
	);

	// Track which sessions are currently dispatching a queued prompt
	const dispatchingRef = useRef<Set<string>>(new Set());

	// Lock to prevent double session creation from draft
	const draftCreatingRef = useRef(false);

	/** Internal: send a prompt directly to the server (no queue check).
	 *  Optional overrides allow queued prompts to use the model/agent/variant
	 *  that was active at enqueue time rather than the current selection. */
	const dispatchPromptDirect = useCallback(
		async (
			sessionId: string,
			text: string,
			images?: string[],
			overrideModel?: SelectedModel,
			overrideAgent?: string,
			overrideVariant?: string,
		) => {
			if (!bridge) return;
			dispatch({ type: "SET_BUSY", payload: true });

			const model = overrideModel ?? state.selectedModel ?? undefined;
			const agent = overrideAgent ?? state.selectedAgent ?? undefined;
			const variant =
				overrideVariant ??
				resolveVariant(
					state.selectedModel,
					state.variantSelections,
					state.agents,
					state.selectedAgent,
				);

			const res = await bridge.prompt(
				sessionId,
				text,
				images,
				model,
				agent,
				variant,
			);
			if (!res.success) {
				dispatch({ type: "SET_ERROR", payload: res.error ?? "Prompt failed" });
				dispatch({ type: "SET_BUSY", payload: false });
			}
		},
		[
			bridge,
			state.selectedModel,
			state.selectedAgent,
			state.variantSelections,
			state.agents,
		],
	);

	/** Dispatch the next queued prompt for a session (if any). */
	const dispatchNextQueued = useCallback(
		async (sessionId: string) => {
			if (dispatchingRef.current.has(sessionId)) return;
			const queue = state.queuedPrompts[sessionId];
			if (!queue || queue.length === 0) return;

			dispatchingRef.current.add(sessionId);
			const next = queue[0];
			if (!next) return;
			dispatch({ type: "QUEUE_SHIFT", payload: { sessionID: sessionId } });
			await dispatchPromptDirect(
				sessionId,
				next.text,
				next.images,
				next.model,
				next.agent,
				next.variant,
			);
			dispatchingRef.current.delete(sessionId);
		},
		[state.queuedPrompts, dispatchPromptDirect],
	);

	const sendPrompt = useCallback(
		async (text: string, images?: string[]) => {
			if (!bridge) return;
			let sessionId = state.activeSessionId;

			// If no active session but a draft is pending, create the session now
			if (!sessionId && state.draftSessionDirectory) {
				if (draftCreatingRef.current) return; // prevent double creation
				draftCreatingRef.current = true;
				const wasTemporary = state.draftIsTemporary;
				try {
					const newSession = await createSession(
						undefined,
						state.draftSessionDirectory,
					);
					if (!newSession) {
						draftCreatingRef.current = false;
						return;
					}
					dispatch({ type: "CLEAR_DRAFT_SESSION" });
					sessionId = newSession.id;
					if (wasTemporary) {
						dispatch({
							type: "MARK_SESSION_TEMPORARY",
							payload: newSession.id,
						});
					}
				} catch {
					draftCreatingRef.current = false;
					return;
				}
				draftCreatingRef.current = false;
			}

			if (!sessionId) {
				dispatch({
					type: "SET_ERROR",
					payload: "Select or create a session first.",
				});
				return;
			}

			// If session is busy, enqueue instead of sending directly.
			// Read from refs to avoid stale closures when the user switches
			// model/agent/variant right before pressing Enter.
			if (state.busySessionIds.has(sessionId)) {
				const snapModel = selectedModelRef.current;
				const snapAgent = selectedAgentRef.current;
				const snapVariant = resolveVariant(
					snapModel,
					variantSelectionsRef.current,
					agentsRef.current,
					snapAgent,
				);
				const queued: QueuedPrompt = {
					id: crypto.randomUUID(),
					text,
					images,
					createdAt: Date.now(),
					model: snapModel ?? undefined,
					agent: snapAgent ?? undefined,
					variant: snapVariant,
				};
				dispatch({
					type: "QUEUE_ADD",
					payload: { sessionID: sessionId, prompt: queued },
				});
				return;
			}

			await dispatchPromptDirect(sessionId, text, images);
		},
		[
			bridge,
			state.activeSessionId,
			state.draftSessionDirectory,
			state.draftIsTemporary,
			state.busySessionIds,
			dispatchPromptDirect,
			createSession,
		],
	);

	const sendCommand = useCallback(
		async (command: string, args: string) => {
			if (!bridge) return;
			let sessionId = state.activeSessionId;

			if (!sessionId && state.draftSessionDirectory) {
				if (draftCreatingRef.current) return;
				draftCreatingRef.current = true;
				const wasTemporary = state.draftIsTemporary;
				try {
					const newSession = await createSession(
						undefined,
						state.draftSessionDirectory,
					);
					if (!newSession) {
						draftCreatingRef.current = false;
						return;
					}
					dispatch({ type: "CLEAR_DRAFT_SESSION" });
					sessionId = newSession.id;
					if (wasTemporary) {
						dispatch({
							type: "MARK_SESSION_TEMPORARY",
							payload: newSession.id,
						});
					}
				} catch {
					draftCreatingRef.current = false;
					return;
				}
				draftCreatingRef.current = false;
			}

			if (!sessionId) {
				dispatch({
					type: "SET_ERROR",
					payload: "Select or create a session first.",
				});
				return;
			}

			dispatch({ type: "SET_BUSY", payload: true });
			try {
				const model = state.selectedModel ?? undefined;
				const agent = state.selectedAgent ?? undefined;
				const variant = currentVariant;
				await bridge.sendCommand(
					sessionId,
					command,
					args,
					model,
					agent,
					variant,
				);
			} catch (err) {
				dispatch({ type: "SET_BUSY", payload: false });
				dispatch({
					type: "SET_ERROR",
					payload: err instanceof Error ? err.message : String(err),
				});
			}
		},
		[
			bridge,
			state.activeSessionId,
			state.draftSessionDirectory,
			state.draftIsTemporary,
			state.selectedModel,
			state.selectedAgent,
			currentVariant,
			createSession,
		],
	);

	// Auto-dispatch queued prompts when a session transitions from busy to idle
	const prevBusyRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		const prevBusy = prevBusyRef.current;
		const nowBusy = state.busySessionIds;

		// Find sessions that just became idle
		for (const sessionId of prevBusy) {
			if (!nowBusy.has(sessionId)) {
				// Session transitioned busy -> idle
				dispatchNextQueued(sessionId);

				// Send desktop notification for non-active root sessions
				// (subagent/task sessions are not in state.sessions)
				if (
					sessionId !== state.activeSessionId &&
					areNotificationsEnabled() &&
					typeof Notification !== "undefined" &&
					Notification.permission === "granted"
				) {
					const session = state.sessions.find((s) => s.id === sessionId);
					if (session) {
						const title = session.title || "Untitled";
						const notification = new Notification("Session complete", {
							body: title,
						});
						notification.onclick = () => {
							window.focus();
							selectSession(sessionId);
						};
					}
				}
			}
		}

		prevBusyRef.current = new Set(nowBusy);
	}, [
		state.busySessionIds,
		state.activeSessionId,
		state.sessions,
		dispatchNextQueued,
		selectSession,
	]);

	// Send desktop notification when a question arrives for a non-active session
	const prevQuestionsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		const prevKeys = prevQuestionsRef.current;
		const nowKeys = new Set(Object.keys(state.pendingQuestions));

		for (const sessionId of nowKeys) {
			if (
				!prevKeys.has(sessionId) &&
				sessionId !== state.activeSessionId &&
				areNotificationsEnabled() &&
				typeof Notification !== "undefined" &&
				Notification.permission === "granted"
			) {
				// Skip subagent/task sessions (they are not in state.sessions)
				const session = state.sessions.find((s) => s.id === sessionId);
				if (session) {
					const title = session.title || "Untitled";
					const notification = new Notification("Question waiting", {
						body: title,
					});
					notification.onclick = () => {
						window.focus();
						selectSession(sessionId);
					};
				}
			}
		}

		prevQuestionsRef.current = nowKeys;
	}, [
		state.pendingQuestions,
		state.activeSessionId,
		state.sessions,
		selectSession,
	]);

	// Send desktop notification when a permission is requested for a non-active session
	const prevPermissionsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		const prevKeys = prevPermissionsRef.current;
		const nowKeys = new Set(Object.keys(state.pendingPermissions));

		for (const sessionId of nowKeys) {
			if (
				!prevKeys.has(sessionId) &&
				sessionId !== state.activeSessionId &&
				areNotificationsEnabled() &&
				typeof Notification !== "undefined" &&
				Notification.permission === "granted"
			) {
				// Skip subagent/task sessions (they are not in state.sessions)
				const session = state.sessions.find((s) => s.id === sessionId);
				if (session) {
					const title = session.title || "Untitled";
					const notification = new Notification("Permission requested", {
						body: title,
					});
					notification.onclick = () => {
						window.focus();
						selectSession(sessionId);
					};
				}
			}
		}

		prevPermissionsRef.current = nowKeys;
	}, [
		state.pendingPermissions,
		state.activeSessionId,
		state.sessions,
		selectSession,
	]);

	const abortSession = useCallback(async () => {
		if (!bridge || !state.activeSessionId) return;
		await bridge.abort(state.activeSessionId);
	}, [bridge, state.activeSessionId]);

	const respondPermission = useCallback(
		async (response: "once" | "always" | "reject") => {
			if (!bridge || !state.activeSessionId) return;
			const pending = state.pendingPermissions[state.activeSessionId];
			if (!pending) return;
			await bridge.respondPermission(
				state.activeSessionId,
				pending.id,
				response,
			);
			dispatch({
				type: "SET_PERMISSION",
				payload: { sessionID: state.activeSessionId, clear: true },
			});
		},
		[bridge, state.pendingPermissions, state.activeSessionId],
	);

	const replyQuestion = useCallback(
		async (answers: QuestionAnswer[]) => {
			if (!bridge || !state.activeSessionId) return;
			const pending = state.pendingQuestions[state.activeSessionId];
			if (!pending) return;
			await bridge.replyQuestion(pending.id, answers);
			dispatch({
				type: "SET_QUESTION",
				payload: { sessionID: state.activeSessionId, clear: true },
			});
		},
		[bridge, state.pendingQuestions, state.activeSessionId],
	);

	const rejectQuestion = useCallback(async () => {
		if (!bridge || !state.activeSessionId) return;
		const pending = state.pendingQuestions[state.activeSessionId];
		if (!pending) return;
		await bridge.rejectQuestion(pending.id);
		dispatch({
			type: "SET_QUESTION",
			payload: { sessionID: state.activeSessionId, clear: true },
		});
	}, [bridge, state.pendingQuestions, state.activeSessionId]);

	const setModel = useCallback((model: SelectedModel | null) => {
		dispatch({ type: "SET_SELECTED_MODEL", payload: model });
	}, []);

	const setAgent = useCallback((agent: string | null) => {
		dispatch({ type: "SET_SELECTED_AGENT", payload: agent });
		try {
			if (agent) {
				localStorage.setItem("opencode:selectedAgent", agent);
			} else {
				localStorage.removeItem("opencode:selectedAgent");
			}
		} catch {
			/* ignore */
		}
	}, []);

	const doCycleVariant = useCallback(() => {
		if (!state.selectedModel) return;
		const model = findModel(
			state.providers,
			state.selectedModel.providerID,
			state.selectedModel.modelID,
		);
		const key = variantKey(
			state.selectedModel.providerID,
			state.selectedModel.modelID,
		);
		const current = state.variantSelections[key];
		const next = cycleVariant(current, model);
		const newSelections = { ...state.variantSelections };
		if (next === undefined) {
			delete newSelections[key];
		} else {
			newSelections[key] = next;
		}
		dispatch({ type: "SET_VARIANT_SELECTIONS", payload: newSelections });
		try {
			localStorage.setItem(
				"opencode:variantSelections",
				JSON.stringify(newSelections),
			);
		} catch {
			/* ignore */
		}
	}, [state.selectedModel, state.providers, state.variantSelections]);

	const setVariant = useCallback(
		(variant: string | undefined) => {
			if (!state.selectedModel) return;
			const key = variantKey(
				state.selectedModel.providerID,
				state.selectedModel.modelID,
			);
			const newSelections = { ...state.variantSelections };
			if (variant === undefined) {
				delete newSelections[key];
			} else {
				newSelections[key] = variant;
			}
			dispatch({ type: "SET_VARIANT_SELECTIONS", payload: newSelections });
			try {
				localStorage.setItem(
					"opencode:variantSelections",
					JSON.stringify(newSelections),
				);
			} catch {
				/* ignore */
			}
		},
		[state.selectedModel, state.variantSelections],
	);

	const startDraftSession = useCallback(
		(directory: string) => {
			// Auto-delete the previous session if it was temporary
			const prevId = activeSessionIdRef.current;
			if (prevId && temporarySessionsRef.current.has(prevId)) {
				dispatch({ type: "SESSION_DELETED", payload: prevId });
				bridge?.deleteSession(prevId);
			}
			dispatch({ type: "START_DRAFT_SESSION", payload: directory });
			// Reset agent to default for new sessions (keep model as-is)
			dispatch({ type: "SET_SELECTED_AGENT", payload: null });
		},
		[bridge],
	);

	const setDraftTemporary = useCallback((temporary: boolean) => {
		dispatch({ type: "SET_DRAFT_TEMPORARY", payload: temporary });
	}, []);

	/** Re-fetch providers from the server and update global state. */
	const refreshProviders = useCallback(async () => {
		if (!bridge) return;
		const res = await bridge.getProviders();
		if (res.success && res.data) {
			dispatch({ type: "SET_PROVIDERS", payload: res.data });
		}
	}, [bridge]);

	const clearError = useCallback(() => {
		dispatch({ type: "SET_ERROR", payload: null });
		if (state.bootState === "error") {
			dispatch({ type: "SET_BOOT_STATE", payload: { state: "ready" } });
		}
	}, [state.bootState]);

	const getQueuedPrompts = useCallback(
		(sessionId: string) => state.queuedPrompts[sessionId] ?? [],
		[state.queuedPrompts],
	);

	const removeFromQueue = useCallback((sessionId: string, promptId: string) => {
		dispatch({
			type: "QUEUE_REMOVE",
			payload: { sessionID: sessionId, promptID: promptId },
		});
	}, []);

	const reorderQueue = useCallback(
		(sessionId: string, fromIndex: number, toIndex: number) => {
			dispatch({
				type: "QUEUE_REORDER",
				payload: { sessionID: sessionId, fromIndex, toIndex },
			});
		},
		[],
	);

	const updateQueuedPrompt = useCallback(
		(sessionId: string, promptId: string, text: string) => {
			dispatch({
				type: "QUEUE_UPDATE",
				payload: { sessionID: sessionId, promptID: promptId, text },
			});
		},
		[],
	);

	const sendQueuedNow = useCallback(
		async (sessionId: string, promptId: string) => {
			const queue = state.queuedPrompts[sessionId] ?? [];
			if (queue.length === 0) return;

			const index = queue.findIndex((item) => item.id === promptId);
			if (index === -1) return;
			const target = queue[index];
			if (!target) return;

			if (busySessionIdsRef.current.has(sessionId)) {
				if (index > 0) {
					dispatch({
						type: "QUEUE_REORDER",
						payload: { sessionID: sessionId, fromIndex: index, toIndex: 0 },
					});
				}
				if (bridge) {
					await bridge.abort(sessionId);
				}
				return;
			}

			dispatch({
				type: "QUEUE_REMOVE",
				payload: { sessionID: sessionId, promptID: promptId },
			});

			await dispatchPromptDirect(
				sessionId,
				target.text,
				target.images,
				target.model,
				target.agent,
				target.variant,
			);
		},
		[state.queuedPrompts, bridge, dispatchPromptDirect],
	);

	const revertToMessage = useCallback(
		async (messageID: string) => {
			if (!bridge || !state.activeSessionId) return;
			// Abort if session is busy before reverting
			if (state.busySessionIds.has(state.activeSessionId)) {
				await bridge.abort(state.activeSessionId);
			}
			try {
				const res = await bridge.revertSession(
					state.activeSessionId,
					messageID,
				);
				if (res.success && res.data) {
					dispatch({ type: "SESSION_UPDATED", payload: res.data });
				}
				// Re-fetch messages to reflect the reverted state
				const msgRes = await bridge.getMessages(state.activeSessionId);
				if (msgRes.success && msgRes.data) {
					dispatch({ type: "SET_MESSAGES", payload: msgRes.data });
				}
			} catch (err) {
				dispatch({
					type: "SET_ERROR",
					payload:
						err instanceof Error ? err.message : "Failed to revert session",
				});
			}
		},
		[bridge, state.activeSessionId, state.busySessionIds],
	);

	const unrevert = useCallback(async () => {
		if (!bridge || !state.activeSessionId) return;
		try {
			const res = await bridge.unrevertSession(state.activeSessionId);
			if (res.success && res.data) {
				dispatch({ type: "SESSION_UPDATED", payload: res.data });
			}
			// Re-fetch messages to include the restored messages
			const msgRes = await bridge.getMessages(state.activeSessionId);
			if (msgRes.success && msgRes.data) {
				dispatch({ type: "SET_MESSAGES", payload: msgRes.data });
			}
		} catch (err) {
			dispatch({
				type: "SET_ERROR",
				payload:
					err instanceof Error ? err.message : "Failed to unrevert session",
			});
		}
	}, [bridge, state.activeSessionId]);

	const forkFromMessage = useCallback(
		async (messageID: string) => {
			if (!bridge || !state.activeSessionId) return;
			try {
				const res = await bridge.forkSession(state.activeSessionId, messageID);
				if (res.success && res.data) {
					// Navigate to the newly forked session
					await selectSession(res.data.id);
				}
			} catch (err) {
				dispatch({
					type: "SET_ERROR",
					payload:
						err instanceof Error ? err.message : "Failed to fork session",
				});
			}
		},
		[bridge, state.activeSessionId, selectSession],
	);

	const setSessionColor = useCallback(
		(sessionId: string, color: SessionColor) => {
			dispatch({
				type: "SET_SESSION_META",
				payload: { sessionId, meta: { color } },
			});
		},
		[],
	);

	const setSessionTags = useCallback((sessionId: string, tags: string[]) => {
		dispatch({
			type: "SET_SESSION_META",
			payload: { sessionId, meta: { tags } },
		});
	}, []);

	const registerWorktree = useCallback(
		(worktreeDir: string, parentDir: string) => {
			dispatch({
				type: "REGISTER_WORKTREE",
				payload: { worktreeDir, parentDir },
			});
		},
		[],
	);

	const unregisterWorktree = useCallback((worktreeDir: string) => {
		dispatch({ type: "UNREGISTER_WORKTREE", payload: worktreeDir });
	}, []);

	const value = useMemo<OpenCodeContextValue>(
		() => ({
			state,
			addProject,
			removeProject,
			disconnect,
			selectSession,
			createSession,
			deleteSession,
			renameSession,
			sendPrompt,
			sendCommand,
			abortSession,
			respondPermission,
			replyQuestion,
			rejectQuestion,
			setModel,
			setAgent,
			cycleVariant: doCycleVariant,
			setVariant,
			currentVariant,
			clearError,
			refreshProviders,
			refreshSessions,
			getQueuedPrompts,
			removeFromQueue,
			reorderQueue,
			updateQueuedPrompt,
			sendQueuedNow,
			openDirectory,
			connectToProject,
			startDraftSession,
			setDraftTemporary,
			revertToMessage,
			unrevert,
			forkFromMessage,
			setSessionColor,
			setSessionTags,
			registerWorktree,
			unregisterWorktree,
		}),
		[
			state,
			addProject,
			removeProject,
			disconnect,
			selectSession,
			createSession,
			deleteSession,
			renameSession,
			sendPrompt,
			sendCommand,
			abortSession,
			respondPermission,
			replyQuestion,
			rejectQuestion,
			setModel,
			setAgent,
			doCycleVariant,
			setVariant,
			currentVariant,
			clearError,
			refreshProviders,
			refreshSessions,
			getQueuedPrompts,
			removeFromQueue,
			reorderQueue,
			updateQueuedPrompt,
			sendQueuedNow,
			openDirectory,
			connectToProject,
			startDraftSession,
			setDraftTemporary,
			revertToMessage,
			unrevert,
			forkFromMessage,
			setSessionColor,
			setSessionTags,
			registerWorktree,
			unregisterWorktree,
		],
	);

	// Clean up temporary sessions on window unload (app close / refresh)
	useEffect(() => {
		const cleanup = () => {
			for (const id of temporarySessionsRef.current) {
				bridge?.deleteSession(id).catch(() => {
					/* best-effort cleanup on unload */
				});
			}
		};
		window.addEventListener("beforeunload", cleanup);
		return () => window.removeEventListener("beforeunload", cleanup);
	}, [bridge]);

	return (
		<OpenCodeContext.Provider value={value}>
			{children}
		</OpenCodeContext.Provider>
	);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useOpenCode(): OpenCodeContextValue {
	const ctx = useContext(OpenCodeContext);
	if (!ctx) {
		throw new Error("useOpenCode must be used within <OpenCodeProvider>");
	}
	return ctx;
}
