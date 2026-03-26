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
	Session as BaseSession,
	Command,
	Message,
	Event as OpenCodeEvent,
	Part,
	PermissionRequest,
	Provider,
	QuestionAnswer,
	QuestionRequest,
} from "@opencode-ai/sdk/v2/client";

/**
 * Extended session type that includes the project directory the session was
 * loaded from.  The opencode server already scopes session listings per
 * project (via the `x-opencode-directory` header), but the `directory` field
 * stored *on* each session may differ slightly from the connection directory
 * (trailing slashes, symlink resolution, git-toplevel normalization, etc.).
 *
 * `_projectDir` is set by the bridge/IPC layer to the *connection* directory
 * that returned the session, so the UI can group sessions reliably without
 * brittle string equality on `session.directory`.
 */
export type Session = BaseSession & { _projectDir?: string };

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
import {
	resolveVariant,
	useVariant,
	type VariantSelections,
} from "@/hooks/opencode/use-variant";
import {
	DEFAULT_SERVER_URL,
	MAX_RECENT_PROJECTS,
	STORAGE_KEYS,
} from "@/lib/constants";
import {
	persistOrRemoveJSON,
	storageGet,
	storageParsed,
	storageRemove,
	storageSet,
	storageSetJSON,
	storageSetOrRemove,
} from "@/lib/safe-storage";
import {
	getSessionDrafts,
	persistSessionDrafts,
	type SessionDraftMap,
} from "@/lib/session-drafts";
import { getErrorMessage } from "@/lib/utils";
import type {
	BridgeEvent,
	ConnectionConfig,
	ConnectionStatus,
	OpenCodeBridge,
	ProvidersData,
	SelectedModel,
	Workspace,
} from "@/types/electron";

/** Max entries to retain in _deletedSessionIds to prevent unbounded growth */
const MAX_DELETED_SESSION_IDS = 200;

/**
 * Given the list of providers and a `provider -> modelID` default map from the
 * server, resolve the first valid `SelectedModel` that exists.
 */
export function resolveServerDefaultModel(
	providers: Provider[],
	providerDefaults: Record<string, string>,
): SelectedModel | null {
	for (const provider of providers) {
		const modelID = providerDefaults[provider.id];
		if (typeof modelID !== "string") continue;
		if (!(modelID in provider.models)) continue;
		return { providerID: provider.id, modelID };
	}

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

function isModelAvailable(providers: Provider[], model: SelectedModel | null) {
	if (!model) return false;
	const provider = providers.find((p) => p.id === model.providerID);
	return !!provider && model.modelID in provider.models;
}

function getSessionDirectory(session: Session | undefined | null) {
	if (!session) return null;
	return session._projectDir ?? session.directory ?? null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface RecentProject {
	directory: string;
	serverUrl: string;
	username?: string;
	lastConnected: number;
}

export const NOTIFICATIONS_ENABLED_KEY = STORAGE_KEYS.NOTIFICATIONS_ENABLED;
export const LOCAL_WORKSPACE_ID = "local";

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

interface SessionMeta {
	color?: SessionColor;
	tags?: string[];
}

type SessionMetaMap = Record<string, SessionMeta>;

function getSessionMetaMap(): SessionMetaMap {
	return storageParsed<SessionMetaMap>(STORAGE_KEYS.SESSION_META) ?? {};
}

function persistSessionMetaMap(meta: SessionMetaMap) {
	// Prune empty entries
	const pruned: SessionMetaMap = {};
	for (const [id, m] of Object.entries(meta)) {
		if ((m.color && m.color !== null) || (m.tags && m.tags.length > 0)) {
			pruned[id] = m;
		}
	}
	persistOrRemoveJSON(
		STORAGE_KEYS.SESSION_META,
		pruned,
		Object.keys(pruned).length === 0,
	);
}

// ---------------------------------------------------------------------------
// Worktree metadata (maps worktree directory -> metadata incl. parent)
// ---------------------------------------------------------------------------

export interface WorktreeMetadata {
	parentDir: string;
	branch: string;
	createdAt: string;
	lastOpenedAt: string;
}

type WorktreeParentMap = Record<string, WorktreeMetadata>;

/** Helper to get the parent directory string from a metadata entry. */
export function getWorktreeParentDir(
	map: WorktreeParentMap,
	dir: string,
): string | undefined {
	return map[dir]?.parentDir;
}

function getWorktreeParents(): WorktreeParentMap {
	const raw =
		storageParsed<Record<string, unknown>>(STORAGE_KEYS.WORKTREE_PARENTS) ?? {};
	const result: WorktreeParentMap = {};
	for (const [dir, val] of Object.entries(raw)) {
		if (typeof val === "string") {
			// Migrate old format: plain string parentDir -> full metadata
			result[dir] = {
				parentDir: val,
				branch: "unknown",
				createdAt: new Date().toISOString(),
				lastOpenedAt: new Date().toISOString(),
			};
		} else if (val && typeof val === "object" && "parentDir" in val) {
			result[dir] = val as WorktreeMetadata;
		}
	}
	// Persist the migrated format back if any old entries were found
	const hadOldFormat = Object.values(raw).some((v) => typeof v === "string");
	if (hadOldFormat && Object.keys(result).length > 0) {
		persistWorktreeParents(result);
	}
	return result;
}

function persistWorktreeParents(map: WorktreeParentMap) {
	persistOrRemoveJSON(
		STORAGE_KEYS.WORKTREE_PARENTS,
		map,
		Object.keys(map).length === 0,
	);
}

/**
 * Returns true when the configured opencode server points to the local machine.
 * Used to decide whether native Electron dialogs make sense (local) or whether
 * the user should type a remote path instead.
 */
function isLocalServer(
	raw = storageGet(STORAGE_KEYS.SERVER_URL) ?? DEFAULT_SERVER_URL,
): boolean {
	try {
		const hostname = new URL(raw).hostname;
		return ["localhost", "127.0.0.1", "::1"].includes(hostname);
	} catch {
		return false;
	}
}

function getWorkspaceRootDirectory(
	directory: string,
	worktreeParents: WorktreeParentMap,
): string {
	return worktreeParents[directory]?.parentDir ?? directory;
}

function getWorkspaceStoredConfig() {
	const directory = storageGet(STORAGE_KEYS.DIRECTORY)?.trim() ?? "";
	if (!directory) return null;
	return {
		directory,
		serverUrl: storageGet(STORAGE_KEYS.SERVER_URL) ?? DEFAULT_SERVER_URL,
		username: storageGet(STORAGE_KEYS.USERNAME) ?? undefined,
	};
}

function createLocalWorkspace(): Workspace {
	return {
		id: LOCAL_WORKSPACE_ID,
		name: "Local",
		serverUrl: DEFAULT_SERVER_URL,
		isLocal: true,
		projects: [],
		selectedModel: null,
		selectedAgent: null,
		lastActiveSessionId: null,
	};
}

function normalizeWorkspace(workspace: Workspace): Workspace {
	return {
		...workspace,
		name: workspace.name.trim() || (workspace.isLocal ? "Local" : "Workspace"),
		serverUrl: workspace.serverUrl.trim() || DEFAULT_SERVER_URL,
		projects: Array.from(
			new Set(
				(workspace.projects ?? [])
					.map((project) => project.trim())
					.filter(Boolean),
			),
		),
		selectedModel: workspace.selectedModel ?? null,
		selectedAgent: workspace.selectedAgent ?? null,
		lastActiveSessionId: workspace.lastActiveSessionId ?? null,
	};
}

function getStoredWorkspaces(): Workspace[] {
	const parsed = storageParsed<Workspace[]>(STORAGE_KEYS.WORKSPACES) ?? [];
	const workspaces = parsed
		.filter((workspace): workspace is Workspace => !!workspace?.id)
		.map((workspace) =>
			normalizeWorkspace({
				...workspace,
				isLocal: workspace.id === LOCAL_WORKSPACE_ID || workspace.isLocal,
			}),
		);
	const localWorkspace = workspaces.find(
		(workspace) => workspace.id === LOCAL_WORKSPACE_ID,
	);
	if (!localWorkspace) {
		workspaces.unshift(createLocalWorkspace());
	}
	return workspaces.map((workspace) =>
		workspace.id === LOCAL_WORKSPACE_ID
			? normalizeWorkspace({
					...workspace,
					name: workspace.name || "Local",
					serverUrl: DEFAULT_SERVER_URL,
					isLocal: true,
				})
			: workspace,
	);
}

function persistWorkspaces(workspaces: Workspace[]) {
	storageSetJSON(
		STORAGE_KEYS.WORKSPACES,
		workspaces.map((workspace) => normalizeWorkspace(workspace)),
	);
}

function getActiveWorkspaceId(workspaces: Workspace[]) {
	const stored = storageGet(STORAGE_KEYS.ACTIVE_WORKSPACE_ID);
	if (stored && workspaces.some((workspace) => workspace.id === stored)) {
		return stored;
	}
	return workspaces[0]?.id ?? LOCAL_WORKSPACE_ID;
}

function migrateLegacyWorkspaceStorage(): Workspace[] {
	const existing = getStoredWorkspaces();
	const legacyConfig = getWorkspaceStoredConfig();
	if (!legacyConfig) return existing;
	const next = [...existing];
	const localIndex = next.findIndex(
		(workspace) => workspace.id === LOCAL_WORKSPACE_ID,
	);
	const localWorkspace = next[localIndex] ?? createLocalWorkspace();
	const nextProjects = new Set(localWorkspace.projects);
	nextProjects.add(legacyConfig.directory);
	const migrated = normalizeWorkspace({
		...localWorkspace,
		username: legacyConfig.username,
		projects: [...nextProjects],
	});
	if (localIndex >= 0) next[localIndex] = migrated;
	else next.unshift(migrated);
	persistWorkspaces(next);
	storageSet(STORAGE_KEYS.ACTIVE_WORKSPACE_ID, LOCAL_WORKSPACE_ID);
	return next;
}

function getRecentProjects(): RecentProject[] {
	return storageParsed<RecentProject[]>(STORAGE_KEYS.RECENT_PROJECTS) ?? [];
}

function addRecentProject(project: RecentProject): RecentProject[] {
	const existing = getRecentProjects().filter(
		(p) => p.directory !== project.directory,
	);
	const updated = [project, ...existing].slice(0, MAX_RECENT_PROJECTS);
	storageSetJSON(STORAGE_KEYS.RECENT_PROJECTS, updated);
	return updated;
}

function getUnreadSessionIds(): Set<string> {
	const arr = storageParsed<string[]>(STORAGE_KEYS.UNREAD_SESSIONS);
	return arr ? new Set(arr) : new Set();
}

function persistUnreadSessionIds(ids: Set<string>) {
	persistOrRemoveJSON(STORAGE_KEYS.UNREAD_SESSIONS, [...ids], ids.size === 0);
}

function areNotificationsEnabled(): boolean {
	const raw = storageGet(STORAGE_KEYS.NOTIFICATIONS_ENABLED);
	// Default to true if no preference stored
	return raw === null || raw === "true";
}

export type QueueMode = "queue" | "interrupt" | "after-part";

export interface QueuedPrompt {
	id: string;
	text: string;
	images?: string[];
	createdAt: number;
	model?: SelectedModel;
	agent?: string;
	variant?: string;
	/** How this prompt should be dispatched:
	 *  - "queue": wait for the session to fully complete (default)
	 *  - "interrupt": abort immediately and send (never actually queued)
	 *  - "after-part": wait for the current tool/text part to finish, then abort and send */
	mode: QueueMode;
}

export interface MessageEntry {
	info: Message;
	parts: Part[];
}

export interface OpenCodeState {
	/** Configured workspaces. Local is always pinned. */
	workspaces: Workspace[];
	/** Currently selected workspace tab. */
	activeWorkspaceId: string;
	/** Maps connected project directories to their workspace. */
	projectWorkspaceMap: Record<string, string>;
	/** Per-project connection statuses keyed by directory */
	connections: Record<string, ConnectionStatus>;
	/** All sessions from all connected projects */
	sessions: Session[];
	/** Currently selected session ID */
	activeSessionId: string | null;
	/** Messages for the active session */
	messages: MessageEntry[];
	/** Newer active-session messages trimmed out of the current window */
	messageForwardBuffer: MessageEntry[];
	/** Whether older messages exist before the loaded active-session window */
	messageHistoryHasMore: boolean;
	/** Opaque cursor for fetching the next page of older messages */
	messageHistoryCursor: string | null;
	/** Whether newer messages exist after the loaded active-session window */
	messageWindowHasNewer: boolean;
	/** Whether messages are being fetched for a newly selected session */
	isLoadingMessages: boolean;
	/** Whether older messages are currently being prepended to the active window */
	isLoadingOlderMessages: boolean;
	/** Whether newer messages are currently being restored into the active window */
	isLoadingNewerMessages: boolean;
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
	/** Server process logs captured during a failed startup */
	bootLogs: string | null;
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
	/** Local-only unsent textarea drafts keyed by session or draft directory. */
	sessionDrafts: SessionDraftMap;
	/** Local-only session metadata (colors, tags) keyed by session ID */
	sessionMeta: SessionMetaMap;
	/** Maps worktree directory -> metadata incl. parent project directory (local-only) */
	worktreeParents: WorktreeParentMap;
	/** Pending worktree cleanup prompt (shown after last session in a worktree is deleted) */
	pendingWorktreeCleanup: {
		worktreeDir: string;
		parentDir: string;
	} | null;
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
		| {
				type: "MESSAGE_REMOVED";
				payload: { sessionID: string; messageID: string };
		  }
	>;
	/** Buffered message snapshots for non-active sessions (keyed by sessionID) */
	_sessionBuffers: Record<
		string,
		{
			messages: Record<string, { info: Message; parts: Record<string, Part> }>;
			hasMore: boolean;
			cursor: string | null;
		}
	>;
	/** Session IDs that have an "after-part" queued prompt waiting for the current part to finish */
	afterPartPending: Set<string>;
	/** Session IDs where an after-part trigger just fired (effect picks this up to abort + dispatch) */
	_afterPartTriggered: Set<string>;
	/** Session IDs that were optimistically deleted - prevents SSE events from re-adding them */
	_deletedSessionIds: Set<string>;
}

/** Check if any project is connected. */
export function hasAnyConnection(
	connections: Record<string, ConnectionStatus>,
): boolean {
	return Object.values(connections).some((c) => c.state === "connected");
}

const initialWorkspaces = migrateLegacyWorkspaceStorage();

const initialState: OpenCodeState = {
	workspaces: initialWorkspaces,
	activeWorkspaceId: getActiveWorkspaceId(initialWorkspaces),
	projectWorkspaceMap: {},
	connections: {},
	sessions: [],
	activeSessionId: null,
	messages: [],
	messageForwardBuffer: [],
	messageHistoryHasMore: false,
	messageHistoryCursor: null,
	messageWindowHasNewer: false,
	isLoadingMessages: false,
	isLoadingOlderMessages: false,
	isLoadingNewerMessages: false,
	isBusy: false,
	pendingPermissions: {},
	pendingQuestions: {},
	lastError: null,
	bootState: "idle",
	bootError: null,
	bootLogs: null,
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
	sessionDrafts: getSessionDrafts(),
	sessionMeta: getSessionMetaMap(),
	worktreeParents: getWorktreeParents(),
	pendingWorktreeCleanup: null,
	childSessions: {},
	trackedChildSessionIds: new Set(),
	_pendingSnapshots: [],
	_sessionBuffers: {},
	afterPartPending: new Set(),
	_afterPartTriggered: new Set(),
	_deletedSessionIds: new Set(),
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type Action =
	| { type: "SET_WORKSPACES"; payload: Workspace[] }
	| { type: "SET_ACTIVE_WORKSPACE"; payload: string }
	| {
			type: "ASSIGN_PROJECT_WORKSPACE";
			payload: { directory: string; workspaceId: string };
	  }
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
	| { type: "SET_SESSION_DRAFT"; payload: { key: string; text: string } }
	| { type: "CLEAR_SESSION_DRAFT"; payload: string }
	| {
			type: "SET_MESSAGES";
			payload: {
				messages: MessageEntry[];
				hasMore: boolean;
				nextCursor?: string | null;
				mode?: "replace" | "prepend" | "append";
			};
	  }
	| { type: "SET_LOADING_OLDER_MESSAGES"; payload: boolean }
	| { type: "SET_LOADING_NEWER_MESSAGES"; payload: boolean }
	| { type: "SET_BUSY"; payload: boolean }
	| { type: "SET_ERROR"; payload: string | null }
	| {
			type: "SET_BOOT_STATE";
			payload: {
				state: OpenCodeState["bootState"];
				error?: string | null;
				logs?: string | null;
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
			type: "MESSAGE_REMOVED";
			payload: { sessionID: string; messageID: string };
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
	| { type: "SET_DRAFT_DIRECTORY"; payload: string }
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
			payload: { worktreeDir: string; parentDir: string; branch: string };
	  }
	| { type: "UNREGISTER_WORKTREE"; payload: string }
	| { type: "TOUCH_WORKTREE"; payload: string }
	| {
			type: "SET_PENDING_WORKTREE_CLEANUP";
			payload: { worktreeDir: string; parentDir: string } | null;
	  }
	| {
			type: "LOAD_CHILD_SESSION";
			payload: {
				childSessionId: string;
				messages: Array<{ info: Message; parts: Part[] }>;
			};
	  }
	| {
			type: "SET_AFTER_PART_PENDING";
			payload: { sessionID: string; pending: boolean };
	  }
	| {
			type: "CLEAR_AFTER_PART_TRIGGERED";
			payload: { sessionID: string };
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

function getMessageCreatedAt(message: { info: Message }): number {
	return message.info.time.created ?? 0;
}

function getPartOrderValue(part: Part): number {
	const timedPart = part as Part & { time?: { start?: number; end?: number } };
	return timedPart.time?.start ?? timedPart.time?.end ?? 0;
}

const MESSAGE_PAGE_SIZE = 30;
const MAX_MESSAGE_WINDOW = 100;
/** Maximum number of idle session message snapshots to keep in the LRU cache */
const MAX_SESSION_BUFFER_CACHE = 8;

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
		...(nextRecord._deltaPositions as Record<string, number> | undefined),
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

/** Extract child session ID from a task tool part's metadata, if present. */
function getChildSessionId(part: Part): string | undefined {
	if (
		part.type === "tool" &&
		part.tool.toLowerCase() === "task" &&
		"metadata" in part.state &&
		part.state.metadata
	) {
		const meta = part.state.metadata as Record<string, unknown>;
		if (typeof meta.sessionId === "string") return meta.sessionId;
	}
	return undefined;
}

/**
 * Buffer an event for a non-active session. Checks tracked child sessions
 * first, then falls back to generic session buffers.
 */
function bufferNonActiveEvent(
	state: OpenCodeState,
	sessionID: string,
	messageID: string,
	updater: (entry: { info: Message; parts: Record<string, Part> }) => {
		info: Message;
		parts: Record<string, Part>;
	},
): OpenCodeState {
	if (state.trackedChildSessionIds.has(sessionID)) {
		const buf = { ...state.childSessions };
		const sessBuf = { ...buf[sessionID] };
		const entry = sessBuf[messageID] ?? {
			info: { id: messageID, sessionID } as Message,
			parts: {},
		};
		sessBuf[messageID] = updater(entry);
		buf[sessionID] = sessBuf;
		return { ...state, childSessions: buf };
	}
	const buf = { ...state._sessionBuffers };
	const existing = buf[sessionID] ?? {
		messages: {},
		hasMore: false,
		cursor: null,
	};
	const msgMap = { ...existing.messages };
	const entry = msgMap[messageID] ?? {
		info: { id: messageID, sessionID } as Message,
		parts: {},
	};
	msgMap[messageID] = updater(entry);
	buf[sessionID] = { ...existing, messages: msgMap };
	return { ...state, _sessionBuffers: buf };
}

function normalizeMessageEntries(
	incoming: MessageEntry[],
	existingMessages: MessageEntry[],
): MessageEntry[] {
	const existingByMsgId = new Map<string, MessageEntry>();
	for (const message of existingMessages) {
		existingByMsgId.set(message.info.id, message);
	}

	return incoming.map((message) => {
		const existing = existingByMsgId.get(message.info.id);
		const existingPartsById = new Map<string, Part>();
		if (existing) {
			for (const part of existing.parts) {
				existingPartsById.set(part.id, part);
			}
		}

		return {
			...message,
			parts: message.parts.map((part) => {
				const prev = existingPartsById.get(part.id);
				if (prev) {
					const prevText =
						((prev as Record<string, unknown>).text as string) ?? "";
					const nextText =
						((part as Record<string, unknown>).text as string) ?? "";
					if (prevText.length >= nextText.length) return prev;
				}
				if ((part as Record<string, unknown>)._deltaPositions) return part;
				return tagPartWithDeltaPositions(part);
			}),
		};
	});
}

function limitMessageWindow(messages: MessageEntry[]): MessageEntry[] {
	if (messages.length <= MAX_MESSAGE_WINDOW) return messages;
	return messages.slice(messages.length - MAX_MESSAGE_WINDOW);
}

function updateMessageArray(
	messages: MessageEntry[],
	messageID: string,
	updater: (entry: MessageEntry | undefined) => MessageEntry | null,
): { messages: MessageEntry[]; found: boolean } {
	const index = messages.findIndex((message) => message.info.id === messageID);
	if (index < 0) {
		const created = updater(undefined);
		if (!created) return { messages, found: false };
		return { messages: [...messages, created], found: false };
	}

	const updated = updater(messages[index]);
	if (!updated) {
		return {
			messages: messages.filter((message) => message.info.id !== messageID),
			found: true,
		};
	}

	const nextMessages = [...messages];
	nextMessages[index] = updated;
	return { messages: nextMessages, found: true };
}

function reducer(state: OpenCodeState, action: Action): OpenCodeState {
	switch (action.type) {
		case "SET_WORKSPACES":
			return {
				...state,
				workspaces: action.payload.map((workspace) =>
					normalizeWorkspace(workspace),
				),
			};

		case "SET_ACTIVE_WORKSPACE":
			return { ...state, activeWorkspaceId: action.payload };

		case "ASSIGN_PROJECT_WORKSPACE":
			return {
				...state,
				projectWorkspaceMap: {
					...state.projectWorkspaceMap,
					[action.payload.directory]: action.payload.workspaceId,
				},
			};

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
					.filter((s) => (s._projectDir ?? s.directory) === action.payload)
					.map((s) => s.id),
			);
			const { [action.payload]: _, ...rest } = state.connections;
			const {
				[action.payload]: _removedWorkspace,
				...restProjectWorkspaceMap
			} = state.projectWorkspaceMap;
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
			const nextBuffers: typeof state._sessionBuffers = {};
			for (const [sid, value] of Object.entries(state._sessionBuffers)) {
				if (!removedSessionIds.has(sid)) nextBuffers[sid] = value;
			}
			const nextUnread = new Set(
				[...state.unreadSessionIds].filter((id) => !removedSessionIds.has(id)),
			);

			// Clean up child session data for removed sessions.
			// Find child session IDs referenced by the removed sessions' messages.
			const childIdsToRemove = new Set<string>();
			// If the active session is being removed, scan its messages
			if (
				state.activeSessionId &&
				removedSessionIds.has(state.activeSessionId)
			) {
				for (const msg of state.messages) {
					for (const part of msg.parts) {
						const childSid = getChildSessionId(part);
						if (childSid) {
							childIdsToRemove.add(childSid);
						}
					}
				}
			}
			// Also remove any removed session IDs that were tracked as children
			for (const sid of removedSessionIds) {
				childIdsToRemove.add(sid);
			}

			let nextChildSessions = state.childSessions;
			let nextTracked = state.trackedChildSessionIds;
			if (childIdsToRemove.size > 0) {
				nextChildSessions = { ...state.childSessions };
				for (const cid of childIdsToRemove) {
					delete nextChildSessions[cid];
				}
				nextTracked = new Set(state.trackedChildSessionIds);
				for (const cid of childIdsToRemove) {
					nextTracked.delete(cid);
				}
			}

			return {
				...state,
				connections: rest,
				projectWorkspaceMap: restProjectWorkspaceMap,
				sessions: state.sessions.filter(
					(s) => (s._projectDir ?? s.directory) !== action.payload,
				),
				busySessionIds: nextBusy,
				unreadSessionIds: nextUnread,
				pendingPermissions: nextPermissions,
				pendingQuestions: nextQuestions,
				queuedPrompts: nextQueues,
				_sessionBuffers: nextBuffers,
				childSessions: nextChildSessions,
				trackedChildSessionIds: nextTracked,
				...(state.activeSessionId &&
				removedSessionIds.has(state.activeSessionId)
					? {
							activeSessionId: null,
							messages: [],
							messageForwardBuffer: [],
							messageHistoryHasMore: false,
							messageHistoryCursor: null,
							messageWindowHasNewer: false,
							isLoadingOlderMessages: false,
							isLoadingNewerMessages: false,
							isBusy: false,
						}
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
				projectWorkspaceMap: {},
				sessions: [],
				activeSessionId: null,
				messages: [],
				messageForwardBuffer: [],
				messageHistoryHasMore: false,
				messageHistoryCursor: null,
				messageWindowHasNewer: false,
				isLoadingMessages: false,
				isLoadingOlderMessages: false,
				isLoadingNewerMessages: false,
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
				bootLogs: action.payload.logs ?? null,
			};
		}

		case "MERGE_PROJECT_SESSIONS": {
			const { directory, sessions } = action.payload;
			// Remove any existing sessions for this project directory, then
			// merge in the fresh list.  Sessions are matched by _projectDir
			// (set by the bridge) so we don't rely on the potentially-divergent
			// session.directory field.
			const filtered = state.sessions.filter(
				(s) => (s._projectDir ?? s.directory) !== directory,
			);
			// Deduplicate by session ID: if the incoming batch contains a
			// session that already exists under a *different* project
			// directory (possible when directories share the same git repo /
			// project_id on the server), keep the existing one and skip the
			// duplicate from the new batch.
			const existingIds = new Set(filtered.map((s) => s.id));
			const deduped = sessions.filter((s) => !existingIds.has(s.id));
			return {
				...state,
				sessions: sortSessionsNewestFirst([...filtered, ...deduped]),
			};
		}

		case "SET_ACTIVE_SESSION": {
			const sid = action.payload;
			let startingBuffers = state._sessionBuffers;
			const previousSid = state.activeSessionId;
			// Always cache outgoing session messages (not just busy ones) for
			// instant display when switching back.
			if (previousSid && previousSid !== sid && state.messages.length > 0) {
				const msgSnapshot: Record<
					string,
					{ info: Message; parts: Record<string, Part> }
				> = {};
				for (const msg of state.messages) {
					const partsById: Record<string, Part> = {};
					for (const p of msg.parts) {
						partsById[p.id] = p;
					}
					msgSnapshot[msg.info.id] = { info: msg.info, parts: partsById };
				}
				startingBuffers = {
					...startingBuffers,
					[previousSid]: {
						messages: msgSnapshot,
						hasMore: state.messageHistoryHasMore,
						cursor: state.messageHistoryCursor,
					},
				};
				// LRU eviction: keep at most MAX_SESSION_BUFFER_CACHE entries.
				// Evict the oldest entries (first keys) when over the limit.
				const bufferKeys = Object.keys(startingBuffers);
				if (bufferKeys.length > MAX_SESSION_BUFFER_CACHE) {
					const evictCount = bufferKeys.length - MAX_SESSION_BUFFER_CACHE;
					const pruned = { ...startingBuffers };
					for (let i = 0; i < evictCount; i++) {
						const key = bufferKeys[i];
						if (key) delete pruned[key];
					}
					startingBuffers = pruned;
				}
			}
			// If we have a buffer for this session, use it for instant display
			const buffered = sid ? startingBuffers[sid] : undefined;
			let initialMessages: MessageEntry[] = [];
			let restoredHasMore = false;
			let restoredCursor: string | null = null;
			if (buffered) {
				initialMessages = Object.values(buffered.messages).map((entry) => ({
					info: entry.info,
					parts: Object.values(entry.parts).map((p) =>
						tagPartWithDeltaPositions(p),
					),
				}));
				restoredHasMore = buffered.hasMore;
				restoredCursor = buffered.cursor;
			}
			// Remove consumed buffer
			const { [sid ?? ""]: _consumed, ...remainingBuffers } = startingBuffers;
			// Clear unread flag for the session being viewed
			let nextUnread = state.unreadSessionIds;
			if (sid && state.unreadSessionIds.has(sid)) {
				nextUnread = new Set(state.unreadSessionIds);
				nextUnread.delete(sid);
			}
			const nextWorkspaces = state.workspaces.map((workspace) =>
				workspace.id === state.activeWorkspaceId
					? {
							...workspace,
							lastActiveSessionId: sid ?? workspace.lastActiveSessionId,
						}
					: workspace,
			);
			return {
				...state,
				workspaces: nextWorkspaces,
				activeSessionId: sid,
				messages: initialMessages,
				messageForwardBuffer: [],
				messageHistoryHasMore: restoredHasMore,
				messageHistoryCursor: restoredCursor,
				messageWindowHasNewer: false,
				isLoadingMessages: sid !== null && !buffered,
				isLoadingOlderMessages: false,
				isLoadingNewerMessages: false,
				isBusy: sid ? state.busySessionIds.has(sid) : false,
				unreadSessionIds: nextUnread,
				// Selecting a real session clears any pending draft
				draftSessionDirectory: sid ? null : state.draftSessionDirectory,
				_pendingSnapshots: [],
				_sessionBuffers: buffered ? remainingBuffers : startingBuffers,
			};
		}

		case "SET_SESSION_DRAFT": {
			const { key, text } = action.payload;
			const trimmed = text.trim();
			if (trimmed.length === 0) {
				if (!(key in state.sessionDrafts)) return state;
				const { [key]: _removed, ...rest } = state.sessionDrafts;
				return { ...state, sessionDrafts: rest };
			}
			if (state.sessionDrafts[key] === text) return state;
			return {
				...state,
				sessionDrafts: { ...state.sessionDrafts, [key]: text },
			};
		}

		case "CLEAR_SESSION_DRAFT": {
			if (!(action.payload in state.sessionDrafts)) return state;
			const { [action.payload]: _removed, ...rest } = state.sessionDrafts;
			return { ...state, sessionDrafts: rest };
		}

		case "SET_MESSAGES": {
			const mode = action.payload.mode ?? "replace";
			const normalizedMessages = normalizeMessageEntries(
				action.payload.messages,
				state.messages,
			);

			if (mode === "prepend") {
				// Deduplicate: remove any incoming messages already in state
				const existingIds = new Set(state.messages.map((m) => m.info.id));
				const newOlder = normalizedMessages.filter(
					(m) => !existingIds.has(m.info.id),
				);
				const combined = [...newOlder, ...state.messages];
				return {
					...state,
					messages: combined,
					messageHistoryHasMore: action.payload.hasMore,
					messageHistoryCursor: action.payload.nextCursor ?? null,
					isLoadingOlderMessages: false,
				};
			}

			if (mode === "append") {
				const appendIds = new Set(
					normalizedMessages.map((message) => message.info.id),
				);
				const retainedMessages = state.messages.filter(
					(message) => !appendIds.has(message.info.id),
				);
				const combinedMessages = [...retainedMessages, ...normalizedMessages];
				return {
					...state,
					messages: limitMessageWindow(combinedMessages),
					messageForwardBuffer: [],
					messageHistoryHasMore: false,
					messageHistoryCursor: null,
					messageWindowHasNewer: false,
					isLoadingNewerMessages: false,
				};
			}

			const existingByMsgId = new Map<string, MessageEntry>();
			for (const message of state.messages) {
				existingByMsgId.set(message.info.id, message);
			}

			if (normalizedMessages.length > 0) {
				const serverLast = normalizedMessages[normalizedMessages.length - 1];
				const serverLastId = serverLast ? serverLast.info.id : null;
				if (serverLastId) {
					for (const [id, entry] of existingByMsgId) {
						if (
							!action.payload.messages.some((message) => message.info.id === id)
						) {
							if (id > serverLastId) {
								normalizedMessages.push(entry);
							}
						}
					}
				}
			}

			let replayedState: OpenCodeState = {
				...state,
				messages: limitMessageWindow(normalizedMessages),
				messageForwardBuffer: [],
				messageHistoryHasMore: action.payload.hasMore,
				messageHistoryCursor: action.payload.nextCursor ?? null,
				messageWindowHasNewer: false,
				isLoadingMessages: false,
				isLoadingOlderMessages: false,
				isLoadingNewerMessages: false,
				_pendingSnapshots: [],
			};
			for (const event of state._pendingSnapshots) {
				replayedState = reducer(replayedState, event);
			}
			return replayedState;
		}

		case "SET_LOADING_OLDER_MESSAGES":
			return { ...state, isLoadingOlderMessages: action.payload };

		case "SET_LOADING_NEWER_MESSAGES":
			return { ...state, isLoadingNewerMessages: action.payload };

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

		case "SESSION_CREATED": {
			// Ignore subagent / child sessions - only root sessions appear in the sidebar.
			if (action.payload.parentID) return state;
			// Ignore SSE echoes for sessions that were optimistically deleted.
			if (state._deletedSessionIds.has(action.payload.id)) return state;
			const projectDir = action.payload._projectDir ?? action.payload.directory;
			if (!(projectDir in state.connections)) return state;
			return {
				...state,
				sessions: sortSessionsNewestFirst([
					action.payload,
					...state.sessions.filter((s) => s.id !== action.payload.id),
				]),
			};
		}

		case "SESSION_UPDATED": {
			const updated = action.payload;
			// Ignore subagent / child sessions - only root sessions appear in the sidebar.
			if (updated.parentID) return state;
			// Ignore SSE echoes for sessions that were optimistically deleted.
			// Without this guard the session flickers back into the sidebar
			// between the optimistic removal and the server's session.deleted event.
			if (state._deletedSessionIds.has(updated.id)) return state;
			const updProjectDir = updated._projectDir ?? updated.directory;
			if (!(updProjectDir in state.connections)) return state;
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
			const deletedId = action.payload;
			const alreadyGone = !state.sessions.some((s) => s.id === deletedId);

			// SSE echo after optimistic delete - session is already removed.
			// Clean the ID out of _deletedSessionIds (no longer needed) and
			// return the same state reference to avoid a re-render.
			if (alreadyGone) {
				if (state._deletedSessionIds.has(deletedId)) {
					const nextDeleted = new Set(state._deletedSessionIds);
					nextDeleted.delete(deletedId);
					return { ...state, _deletedSessionIds: nextDeleted };
				}
				return state;
			}

			// Track that this session was deleted so that any straggling
			// SESSION_UPDATED / SESSION_CREATED SSE events don't re-add it.
			const nextDeleted = new Set(state._deletedSessionIds);
			nextDeleted.add(deletedId);
			// Cap to prevent unbounded growth
			while (nextDeleted.size > MAX_DELETED_SESSION_IDS) {
				const first = nextDeleted.values().next().value;
				if (first !== undefined) {
					nextDeleted.delete(first);
				} else {
					break;
				}
			}

			const { [deletedId]: _deletedQueue, ...remainingQueues } =
				state.queuedPrompts;
			const { [deletedId]: _deletedBuffer, ...remainingBuffers } =
				state._sessionBuffers;
			const nextTemp = new Set(state.temporarySessions);
			nextTemp.delete(deletedId);
			const nextUnread = new Set(state.unreadSessionIds);
			nextUnread.delete(deletedId);
			const nextDrafts = { ...state.sessionDrafts };
			delete nextDrafts[`session:${deletedId}`];

			// Clean up child session data for the deleted session.
			// Find child session IDs referenced by the deleted session's parts.
			const deletedSession = state.sessions.find((s) => s.id === deletedId);
			let nextChildSessions = state.childSessions;
			let nextTracked = state.trackedChildSessionIds;
			if (deletedSession) {
				const childIdsToRemove = new Set<string>();
				// Parts are not directly on session, but child sessions tracked in
				// trackedChildSessionIds are keyed by their own IDs. We need to
				// find which children are referenced by this session. Scan the
				// messages that were loaded for this session.
				const sessionMessages =
					state.activeSessionId === deletedId ? state.messages : [];
				for (const msg of sessionMessages) {
					for (const part of msg.parts) {
						const childSid = getChildSessionId(part);
						if (childSid) {
							childIdsToRemove.add(childSid);
						}
					}
				}
				// Also remove the deleted session itself if tracked as a child
				childIdsToRemove.add(deletedId);

				if (childIdsToRemove.size > 0) {
					nextChildSessions = { ...state.childSessions };
					for (const cid of childIdsToRemove) {
						delete nextChildSessions[cid];
					}
					nextTracked = new Set(state.trackedChildSessionIds);
					for (const cid of childIdsToRemove) {
						nextTracked.delete(cid);
					}
				}
			}

			return {
				...state,
				workspaces: state.workspaces.map((workspace) =>
					workspace.lastActiveSessionId === deletedId
						? { ...workspace, lastActiveSessionId: null }
						: workspace,
				),
				sessions: state.sessions.filter((s) => s.id !== deletedId),
				queuedPrompts: remainingQueues,
				_sessionBuffers: remainingBuffers,
				temporarySessions: nextTemp,
				unreadSessionIds: nextUnread,
				sessionDrafts: nextDrafts,
				_deletedSessionIds: nextDeleted,
				childSessions: nextChildSessions,
				trackedChildSessionIds: nextTracked,
				...(state.activeSessionId === deletedId
					? {
							activeSessionId: null,
							messages: [],
							messageForwardBuffer: [],
							messageHistoryHasMore: false,
							messageHistoryCursor: null,
							messageWindowHasNewer: false,
							isLoadingOlderMessages: false,
							isLoadingNewerMessages: false,
							isBusy: false,
						}
					: {}),
			};
		}

		case "MESSAGE_UPDATED": {
			const msg = action.payload;
			if (msg.sessionID !== state.activeSessionId) {
				return bufferNonActiveEvent(state, msg.sessionID, msg.id, (entry) => ({
					...entry,
					info: msg,
				}));
			}
			// Queue snapshot if messages are still loading from the server
			if (state.isLoadingMessages) {
				return {
					...state,
					_pendingSnapshots: [...state._pendingSnapshots, action],
				};
			}
			const existsInWindow = state.messages.some((m) => m.info.id === msg.id);
			if (existsInWindow) {
				return {
					...state,
					messages: state.messages.map((m) =>
						m.info.id === msg.id ? { ...m, info: msg } : m,
					),
				};
			}

			const appendedMessages = limitMessageWindow([
				...state.messages,
				{ info: msg, parts: [] },
			]);
			const didTrim = appendedMessages.length < state.messages.length + 1;
			return {
				...state,
				messages: appendedMessages,
				messageForwardBuffer: [],
				// If limitMessageWindow trimmed messages, older history exists
				...(didTrim ? { messageHistoryHasMore: true } : {}),
			};
		}

		case "PART_UPDATED": {
			const { part } = action.payload;
			if (part.sessionID !== state.activeSessionId) {
				return bufferNonActiveEvent(
					state,
					part.sessionID,
					part.messageID,
					(entry) => {
						const previous = entry.parts[part.id];
						const tagged = tagPartWithDeltaPositions(part, previous);
						return {
							...entry,
							parts: { ...entry.parts, [part.id]: tagged },
						};
					},
				);
			}
			// Track child session IDs from Task tool parts with metadata.sessionId
			let childTrackPatch:
				| {
						trackedChildSessionIds: Set<string>;
						childSessions: typeof state.childSessions;
				  }
				| undefined;
			const childSid = getChildSessionId(part);
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
			// Queue snapshot if messages are still loading from the server
			if (state.isLoadingMessages) {
				return {
					...state,
					...childTrackPatch,
					_pendingSnapshots: [...state._pendingSnapshots, action],
				};
			}

			const updateEntry = (entry?: MessageEntry): MessageEntry => {
				const currentEntry =
					entry ??
					createPlaceholderMessageEntry(part.sessionID, part.messageID);
				const existingIdx = currentEntry.parts.findIndex(
					(p) => p.id === part.id,
				);
				const previous =
					existingIdx >= 0 ? currentEntry.parts[existingIdx] : undefined;
				const tagged = mergeSnapshotPartWithExisting(part, previous);
				const newParts = [...currentEntry.parts];
				if (existingIdx >= 0) newParts[existingIdx] = tagged;
				else newParts.push(tagged);
				return { ...currentEntry, parts: newParts };
			};

			const sourceEntry = state.messages.find(
				(m) => m.info.id === part.messageID,
			);
			const prevPart = sourceEntry?.parts.find((p) => p.id === part.id);
			const updatedWindow = updateMessageArray(
				state.messages,
				part.messageID,
				updateEntry,
			);

			// After-part trigger: detect when a part just finished while we're
			// waiting for the current part to complete before aborting + sending.
			let afterPartPatch:
				| {
						afterPartPending: Set<string>;
						_afterPartTriggered: Set<string>;
				  }
				| undefined;
			if (state.afterPartPending.has(part.sessionID)) {
				let justFinished = false;

				if (part.type === "tool") {
					const doneStatus =
						part.state.status === "completed" || part.state.status === "error";
					const wasPending =
						!prevPart ||
						(prevPart.type === "tool" &&
							(prevPart.state.status === "running" ||
								prevPart.state.status === "pending"));
					justFinished = doneStatus && wasPending;
				} else if (part.type === "text") {
					const hasEnd = part.time?.end !== undefined;
					const prevHadEnd =
						prevPart?.type === "text" && prevPart.time?.end !== undefined;
					justFinished = hasEnd && !prevHadEnd;
				} else if (part.type === "step-finish") {
					// StepFinishPart arrival always signals a step boundary
					justFinished = !prevPart;
				}

				if (justFinished) {
					const nextPending = new Set(state.afterPartPending);
					nextPending.delete(part.sessionID);
					const nextTriggered = new Set(state._afterPartTriggered);
					nextTriggered.add(part.sessionID);
					afterPartPatch = {
						afterPartPending: nextPending,
						_afterPartTriggered: nextTriggered,
					};
				}
			}

			const partUpdatedMessages = limitMessageWindow(updatedWindow.messages);
			const partDidTrim =
				partUpdatedMessages.length < updatedWindow.messages.length;
			return {
				...state,
				...childTrackPatch,
				...afterPartPatch,
				messages: partUpdatedMessages,
				messageForwardBuffer: [],
				// If limitMessageWindow trimmed messages, older history exists
				...(partDidTrim ? { messageHistoryHasMore: true } : {}),
			};
		}

		case "PART_DELTA": {
			const { sessionID, messageID, partID, field, delta } = action.payload;
			if (sessionID !== state.activeSessionId) {
				return bufferNonActiveEvent(state, sessionID, messageID, (entry) => {
					const existing =
						entry.parts[partID] ??
						createPlaceholderPart(sessionID, messageID, partID, field);
					const nextPart = applyStreamingDeltaToPart(existing, field, delta);
					return {
						...entry,
						parts: { ...entry.parts, [partID]: nextPart },
					};
				});
			}

			if (state.isLoadingMessages) {
				return {
					...state,
					_pendingSnapshots: [...state._pendingSnapshots, action],
				};
			}

			const updateEntry = (entry?: MessageEntry): MessageEntry => {
				const current =
					entry ?? createPlaceholderMessageEntry(sessionID, messageID);
				const partIndex = current.parts.findIndex((p) => p.id === partID);
				const existingPart =
					partIndex >= 0 ? current.parts[partIndex] : undefined;
				const existing =
					existingPart ??
					createPlaceholderPart(sessionID, messageID, partID, field);
				const nextPart = applyStreamingDeltaToPart(existing, field, delta);
				const nextParts = [...current.parts];
				if (partIndex >= 0) nextParts[partIndex] = nextPart;
				else nextParts.push(nextPart);
				return { ...current, parts: nextParts };
			};
			const deltaUpdated = updateMessageArray(
				state.messages,
				messageID,
				updateEntry,
			).messages;
			const deltaMessages = limitMessageWindow(deltaUpdated);
			const deltaDidTrim = deltaMessages.length < deltaUpdated.length;
			return {
				...state,
				messages: deltaMessages,
				messageForwardBuffer: [],
				// If limitMessageWindow trimmed messages, older history exists
				...(deltaDidTrim ? { messageHistoryHasMore: true } : {}),
			};
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
				const entry = sessionBuffer.messages[messageID];
				if (!entry || !(partID in entry.parts)) return state;
				const { [partID]: _removed, ...remainingParts } = entry.parts;
				const newBuffers = { ...state._sessionBuffers };
				newBuffers[sessionID] = {
					...sessionBuffer,
					messages: {
						...sessionBuffer.messages,
						[messageID]: { ...entry, parts: remainingParts },
					},
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
				messageForwardBuffer: [],
			};
		}

		case "MESSAGE_REMOVED": {
			const { sessionID, messageID } = action.payload;
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
					if (!(messageID in childBuf)) return state;
					const { [messageID]: _removedMsg, ...remainingChildMsgs } = childBuf;
					return {
						...state,
						childSessions: {
							...state.childSessions,
							[sessionID]: remainingChildMsgs,
						},
					};
				}
				const sessionBuffer = state._sessionBuffers[sessionID];
				if (!sessionBuffer) return state;
				if (!(messageID in sessionBuffer.messages)) return state;
				const { [messageID]: _removed, ...remainingMsgs } =
					sessionBuffer.messages;
				const newBuffers = { ...state._sessionBuffers };
				newBuffers[sessionID] = {
					...sessionBuffer,
					messages: remainingMsgs,
				};
				return { ...state, _sessionBuffers: newBuffers };
			}
			return {
				...state,
				messages: state.messages.filter((m) => m.info.id !== messageID),
				messageForwardBuffer: [],
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
			// Keep session buffer cached even when session goes idle so
			// switching back to it is instant (LRU eviction handles cleanup).
			const nextBuffers = state._sessionBuffers;
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
			for (const [sessionID, status] of Object.entries(statuses)) {
				if (status.type === "busy") {
					newBusy.add(sessionID);
				} else {
					newBusy.delete(sessionID);
				}
			}
			const nextBuffers = state._sessionBuffers;
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

		case "SET_AFTER_PART_PENDING": {
			const { sessionID, pending } = action.payload;
			const next = new Set(state.afterPartPending);
			if (pending) {
				next.add(sessionID);
			} else {
				next.delete(sessionID);
			}
			return { ...state, afterPartPending: next };
		}

		case "CLEAR_AFTER_PART_TRIGGERED": {
			const { sessionID } = action.payload;
			const next = new Set(state._afterPartTriggered);
			next.delete(sessionID);
			return { ...state, _afterPartTriggered: next };
		}

		case "SET_RECENT_PROJECTS":
			return { ...state, recentProjects: action.payload };

		case "START_DRAFT_SESSION":
			return {
				...state,
				draftSessionDirectory: action.payload,
				activeSessionId: null,
				messages: [],
				messageForwardBuffer: [],
				messageHistoryHasMore: false,
				messageHistoryCursor: null,
				messageWindowHasNewer: false,
				isLoadingMessages: false,
				isLoadingOlderMessages: false,
				isLoadingNewerMessages: false,
				isBusy: false,
			};

		case "SET_DRAFT_DIRECTORY":
			return {
				...state,
				draftSessionDirectory: action.payload,
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
			const { worktreeDir, parentDir, branch } = action.payload;
			const now = new Date().toISOString();
			const next: WorktreeParentMap = {
				...state.worktreeParents,
				[worktreeDir]: {
					parentDir,
					branch,
					createdAt: now,
					lastOpenedAt: now,
				},
			};
			persistWorktreeParents(next);
			return { ...state, worktreeParents: next };
		}

		case "UNREGISTER_WORKTREE": {
			const next = { ...state.worktreeParents };
			delete next[action.payload];
			persistWorktreeParents(next);
			return { ...state, worktreeParents: next };
		}

		case "TOUCH_WORKTREE": {
			const existing = state.worktreeParents[action.payload];
			if (!existing) return state;
			const next: WorktreeParentMap = {
				...state.worktreeParents,
				[action.payload]: {
					...existing,
					lastOpenedAt: new Date().toISOString(),
				},
			};
			persistWorktreeParents(next);
			return { ...state, worktreeParents: next };
		}

		case "SET_PENDING_WORKTREE_CLEANUP":
			return { ...state, pendingWorktreeCleanup: action.payload };

		case "LOAD_CHILD_SESSION": {
			const { childSessionId, messages } = action.payload;
			const existingChildBuf = state.childSessions[childSessionId] ?? {};
			const childBuf: Record<
				string,
				{ info: Message; parts: Record<string, Part> }
			> = { ...existingChildBuf };
			for (const msg of messages) {
				const previousEntry = existingChildBuf[msg.info.id];
				const partsById: Record<string, Part> = previousEntry
					? { ...previousEntry.parts }
					: {};
				for (const p of msg.parts) {
					partsById[p.id] = p;
				}
				childBuf[msg.info.id] = {
					info: msg.info,
					parts: partsById,
				};
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

/**
 * Collect all renderable parts (text + tool) from a child (subagent) session,
 * preserving transcript order. Excludes user-role messages.
 */
export function getChildSessionParts(
	childSessions: OpenCodeState["childSessions"],
	childSessionId: string,
): Part[] {
	const child = childSessions[childSessionId];
	if (!child) return [];

	return Object.values(child)
		.toSorted((a, b) => getMessageCreatedAt(a) - getMessageCreatedAt(b))
		.filter((m) => m.info.role !== "user")
		.flatMap((m) =>
			Object.values(m.parts)
				.toSorted((a, b) => getPartOrderValue(a) - getPartOrderValue(b))
				.filter((p) => {
					if (p.type === "tool") return true;
					if (p.type === "text" && "text" in p && p.text) return true;
					return false;
				}),
		);
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Split contexts  (subscribe to only the slice you need)
// ---------------------------------------------------------------------------

/** Session-related state - sessions list, active session, busy state, queue.
 *  NOTE: `messages` and `childSessions` live in the separate MessagesContext
 *  so that streaming deltas don't trigger re-renders for the sidebar, prompt
 *  box, and other components that only care about session metadata. */
interface SessionContextValue {
	sessions: Session[];
	activeSessionId: string | null;
	isBusy: boolean;
	isLoadingMessages: boolean;
	busySessionIds: Set<string>;
	queuedPrompts: Record<string, QueuedPrompt[]>;
	pendingPermissions: Record<string, PermissionRequest>;
	pendingQuestions: Record<string, QuestionRequest>;
	draftSessionDirectory: string | null;
	draftIsTemporary: boolean;
	temporarySessions: Set<string>;
	unreadSessionIds: Set<string>;
	sessionDrafts: SessionDraftMap;
	sessionMeta: SessionMetaMap;
	recentProjects: RecentProject[];
}

/** Messages + child sessions - isolated so streaming deltas only
 *  re-render the message list, not sidebar/prompt/etc. */
interface MessagesContextValue {
	messages: MessageEntry[];
	childSessions: OpenCodeState["childSessions"];
	messageHistoryHasMore: boolean;
	messageWindowHasNewer: boolean;
	isLoadingOlderMessages: boolean;
	isLoadingNewerMessages: boolean;
}

/** Messages + child sessions - isolated from SessionContext so that
 *  per-token streaming deltas only re-render the message list, not
 *  every component that reads session metadata. */
interface MessagesContextValue {
	messages: MessageEntry[];
	childSessions: OpenCodeState["childSessions"];
	messageHistoryHasMore: boolean;
	messageWindowHasNewer: boolean;
	isLoadingOlderMessages: boolean;
	isLoadingNewerMessages: boolean;
}

/** Model / agent / variant / command state. */
interface ModelContextValue {
	providers: Provider[];
	providerDefaults: Record<string, string>;
	selectedModel: SelectedModel | null;
	agents: Agent[];
	selectedAgent: string | null;
	variantSelections: VariantSelections;
	commands: Command[];
	currentVariant: string | undefined;
}

/** Connection lifecycle state. */
interface ConnectionContextValue {
	workspaces: Workspace[];
	activeWorkspace: Workspace | null;
	activeWorkspaceId: string;
	workspaceStatuses: Record<
		string,
		{
			busy: boolean;
			needsAttention: boolean;
			error: boolean;
			connected: boolean;
		}
	>;
	connections: Record<string, ConnectionStatus>;
	workspaceDirectory: string | null;
	workspaceServerUrl: string | null;
	workspaceUsername: string | null;
	isLocalWorkspace: boolean;
	activeDirectory: string | null;
	bootState: OpenCodeState["bootState"];
	bootError: string | null;
	bootLogs: string | null;
	lastError: string | null;
	worktreeParents: WorktreeParentMap;
	pendingWorktreeCleanup: OpenCodeState["pendingWorktreeCleanup"];
}

/** Stable action functions – these references rarely change. */
interface ActionsContextValue {
	addProject: (
		config: ConnectionConfig,
		options?: { suppressError?: boolean },
	) => Promise<void>;
	removeProject: (directory: string) => Promise<void>;
	disconnect: () => Promise<void>;
	selectSession: (id: string | null) => Promise<void>;
	loadOlderMessages: () => Promise<boolean>;
	loadNewerMessages: () => Promise<boolean>;
	createSession: (
		title?: string,
		directory?: string,
	) => Promise<Session | null>;
	deleteSession: (id: string) => Promise<void>;
	renameSession: (id: string, title: string) => Promise<void>;
	sendPrompt: (
		text: string,
		images?: string[],
		mode?: QueueMode,
	) => Promise<void>;
	findFiles: (directory: string | null, query: string) => Promise<string[]>;
	sendCommand: (command: string, args: string) => Promise<void>;
	abortSession: () => Promise<void>;
	respondPermission: (response: "once" | "always" | "reject") => Promise<void>;
	replyQuestion: (answers: QuestionAnswer[]) => Promise<void>;
	rejectQuestion: () => Promise<void>;
	setModel: (model: SelectedModel | null) => void;
	setAgent: (agent: string | null) => void;
	cycleVariant: () => void;
	clearError: () => void;
	refreshProviders: () => Promise<void>;
	refreshSessions: () => Promise<void>;
	getQueuedPrompts: (sessionId: string) => QueuedPrompt[];
	removeFromQueue: (sessionId: string, promptId: string) => void;
	reorderQueue: (sessionId: string, fromIndex: number, toIndex: number) => void;
	updateQueuedPrompt: (
		sessionId: string,
		promptId: string,
		text: string,
	) => void;
	sendQueuedNow: (sessionId: string, promptId: string) => Promise<void>;
	setSessionDraft: (key: string, text: string) => void;
	clearSessionDraft: (key: string) => void;
	openDirectory: () => Promise<string | null>;
	connectToProject: (
		directory: string,
		serverUrl?: string,
		username?: string,
		password?: string,
	) => Promise<void>;
	startDraftSession: (directory: string) => void;
	setDraftDirectory: (directory: string) => void;
	setDraftTemporary: (temporary: boolean) => void;
	revertToMessage: (messageID: string) => Promise<void>;
	unrevert: () => Promise<void>;
	forkFromMessage: (messageID: string) => Promise<void>;
	setSessionColor: (sessionId: string, color: SessionColor) => void;
	setSessionTags: (sessionId: string, tags: string[]) => void;
	registerWorktree: (
		worktreeDir: string,
		parentDir: string,
		branch: string,
	) => void;
	unregisterWorktree: (worktreeDir: string) => void;
	touchWorktree: (worktreeDir: string) => void;
	clearWorktreeCleanup: () => void;
	createWorkspace: (input: {
		name: string;
		serverUrl: string;
		username?: string;
	}) => void;
	updateWorkspace: (
		workspaceId: string,
		input: Partial<Pick<Workspace, "name" | "serverUrl" | "username">>,
	) => void;
	removeWorkspace: (workspaceId: string) => Promise<void>;
	switchWorkspace: (workspaceId: string) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);
const MessagesContext = createContext<MessagesContextValue | null>(null);
const ModelContext = createContext<ModelContextValue | null>(null);
const ConnectionContext = createContext<ConnectionContextValue | null>(null);
const ActionsContext = createContext<ActionsContextValue | null>(null);

// ---------------------------------------------------------------------------
// Desktop notification helper (deduplicates 3 near-identical effects)
// ---------------------------------------------------------------------------

function useDesktopNotification(
	triggerMap: Record<string, unknown>,
	title: string,
	activeSessionId: string | null,
	sessions: Session[],
	selectSession: (id: string) => void,
) {
	const prevKeysRef = useRef<Set<string>>(new Set());
	const notificationsRef = useRef<Notification[]>([]);
	useEffect(() => {
		const prevKeys = prevKeysRef.current;
		const nowKeys = new Set(Object.keys(triggerMap));
		const newNotifications: Notification[] = [];

		for (const sessionId of nowKeys) {
			if (
				!prevKeys.has(sessionId) &&
				sessionId !== activeSessionId &&
				areNotificationsEnabled() &&
				typeof Notification !== "undefined" &&
				Notification.permission === "granted"
			) {
				const session = sessions.find((s) => s.id === sessionId);
				if (session) {
					const sessionTitle = session.title || "Untitled";
					const notification = new Notification(title, {
						body: sessionTitle,
					});
					notification.onclick = () => {
						window.focus();
						selectSession(sessionId);
					};
					newNotifications.push(notification);
				}
			}
		}

		prevKeysRef.current = nowKeys;
		notificationsRef.current = newNotifications;

		return () => {
			for (const n of notificationsRef.current) {
				n.close();
			}
		};
	}, [triggerMap, title, activeSessionId, sessions, selectSession]);
}

// ---------------------------------------------------------------------------
// Helpers: find model in providers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function OpenCodeProvider({
	children,
	detachedProject,
}: {
	children: ReactNode;
	detachedProject?: string;
}) {
	const [state, dispatch] = useReducer(reducer, initialState);

	const bridge = useMemo<OpenCodeBridge | undefined>(
		() => window.electronAPI?.opencode,
		[],
	);
	const expectedDirectoriesRef = useRef<Set<string>>(new Set());

	// Keep refs so selectSession can read current values without stale closures
	const agentsRef = useRef(state.agents);
	agentsRef.current = state.agents;
	const variantSelectionsRef = useRef(state.variantSelections);
	variantSelectionsRef.current = state.variantSelections;
	const selectedModelRef = useRef(state.selectedModel);
	selectedModelRef.current = state.selectedModel;
	const selectedAgentRef = useRef(state.selectedAgent);
	selectedAgentRef.current = state.selectedAgent;
	const selectSessionRequestRef = useRef(0);
	const childHydrationVersionRef = useRef<Record<string, number>>({});
	const loadedResourceDirectoryRef = useRef<string | null>(null);
	const resourceLoadRequestRef = useRef(0);

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
					dispatch({
						type: "SESSION_CREATED",
						payload: {
							...oc.properties.info,
							_projectDir: event.directory,
						},
					});
					break;
				case "session.updated":
					dispatch({
						type: "SESSION_UPDATED",
						payload: {
							...oc.properties.info,
							_projectDir: event.directory,
						},
					});
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
				case "message.removed":
					dispatch({
						type: "MESSAGE_REMOVED",
						payload: {
							sessionID: oc.properties.sessionID,
							messageID: oc.properties.messageID,
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
						// Skip abort errors — already shown inline on the message
						if (errData.name === "MessageAbortedError") break;
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
		if (state.selectedModel) {
			modelInitialized.current = true;
			storageSetJSON(STORAGE_KEYS.SELECTED_MODEL, state.selectedModel);
		} else if (modelInitialized.current) {
			storageRemove(STORAGE_KEYS.SELECTED_MODEL);
		}
	}, [state.selectedModel]);

	useEffect(() => {
		persistWorkspaces(state.workspaces);
	}, [state.workspaces]);

	useEffect(() => {
		const activeId = state.activeWorkspaceId;
		if (!activeId) return;
		const active = state.workspaces.find((w) => w.id === activeId);
		if (!active) return;
		// Only dispatch when the values actually differ to avoid an infinite
		// loop: .map() + spread always creates new object references, so a
		// naive reference-equality check would always be true, causing
		// dispatch -> new state.workspaces ref -> effect re-fires -> repeat.
		const modelSame =
			active.selectedModel?.providerID === state.selectedModel?.providerID &&
			active.selectedModel?.modelID === state.selectedModel?.modelID;
		const agentSame = active.selectedAgent === state.selectedAgent;
		if (modelSame && agentSame) return;
		const next = state.workspaces.map((workspace) =>
			workspace.id === activeId
				? {
						...workspace,
						selectedModel: state.selectedModel,
						selectedAgent: state.selectedAgent,
					}
				: workspace,
		);
		dispatch({ type: "SET_WORKSPACES", payload: next });
	}, [
		state.activeWorkspaceId,
		state.selectedAgent,
		state.selectedModel,
		state.workspaces,
	]);

	useEffect(() => {
		storageSet(STORAGE_KEYS.ACTIVE_WORKSPACE_ID, state.activeWorkspaceId);
	}, [state.activeWorkspaceId]);

	// Persist unreadSessionIds to localStorage whenever it changes
	useEffect(() => {
		persistUnreadSessionIds(state.unreadSessionIds);
	}, [state.unreadSessionIds]);

	useEffect(() => {
		persistSessionDrafts(state.sessionDrafts);
	}, [state.sessionDrafts]);

	// Request notification permission on startup
	useEffect(() => {
		if (
			typeof Notification !== "undefined" &&
			Notification.permission === "default"
		) {
			Notification.requestPermission().catch(() => {
				/* permission denied or unavailable */
			});
		}
	}, []);

	const {
		currentVariant,
		setModel,
		setAgent,
		cycleVariant: doCycleVariant,
	} = useVariant({
		selectedModel: state.selectedModel,
		providers: state.providers,
		agents: state.agents,
		selectedAgent: state.selectedAgent,
		variantSelections: state.variantSelections,
		dispatch,
	});

	// --- Actions ---

	const loadServerResources = useCallback(
		async (directory?: string | null) => {
			if (!bridge) return;
			const requestId = ++resourceLoadRequestRef.current;
			const targetDirectory = directory?.trim() || undefined;
			const [provRes, agentRes, cmdRes] = await Promise.all([
				bridge.getProviders(targetDirectory),
				bridge.getAgents(targetDirectory),
				bridge.getCommands(targetDirectory),
			]);

			if (requestId !== resourceLoadRequestRef.current) return;

			if (provRes.success && provRes.data) {
				loadedResourceDirectoryRef.current = targetDirectory ?? null;
				dispatch({ type: "SET_PROVIDERS", payload: provRes.data });

				const currentSelection = selectedModelRef.current;
				const storedSelection =
					stateRef.current.workspaces.find(
						(workspace) => workspace.id === stateRef.current.activeWorkspaceId,
					)?.selectedModel ??
					storageParsed<SelectedModel>(STORAGE_KEYS.SELECTED_MODEL);
				const nextSelection = isModelAvailable(
					provRes.data.providers,
					currentSelection,
				)
					? currentSelection
					: isModelAvailable(provRes.data.providers, storedSelection)
						? storedSelection
						: resolveServerDefaultModel(
								provRes.data.providers,
								provRes.data.default,
							);
				dispatch({
					type: "SET_SELECTED_MODEL",
					payload: nextSelection ?? null,
				});

				const parsedVariants = storageParsed<VariantSelections>(
					STORAGE_KEYS.VARIANT_SELECTIONS,
				);
				if (parsedVariants) {
					dispatch({
						type: "SET_VARIANT_SELECTIONS",
						payload: parsedVariants,
					});
				}
			}

			if (agentRes.success && agentRes.data) {
				dispatch({ type: "SET_AGENTS", payload: agentRes.data });
				const savedAgent =
					stateRef.current.workspaces.find(
						(workspace) => workspace.id === stateRef.current.activeWorkspaceId,
					)?.selectedAgent ?? storageGet(STORAGE_KEYS.SELECTED_AGENT);
				const nextAgent =
					savedAgent && agentRes.data.some((a: Agent) => a.name === savedAgent)
						? savedAgent
						: null;
				dispatch({ type: "SET_SELECTED_AGENT", payload: nextAgent });
			}

			if (cmdRes.success && cmdRes.data) {
				dispatch({ type: "SET_COMMANDS", payload: cmdRes.data });
			}
		},
		[bridge],
	);

	const addProject = useCallback(
		async (config: ConnectionConfig, options?: { suppressError?: boolean }) => {
			if (!bridge || !config.directory) return;
			const workspaceId =
				config.workspaceId ??
				stateRef.current.activeWorkspaceId ??
				LOCAL_WORKSPACE_ID;
			dispatch({
				type: "ASSIGN_PROJECT_WORKSPACE",
				payload: { directory: config.directory, workspaceId },
			});
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
			// Load sessions for this project.  The bridge already tags each
			// session with `_projectDir` matching the connection directory, so
			// no additional client-side filtering is needed – the server scopes
			// sessions to this project via the x-opencode-directory header.
			const sessRes = await bridge.listSessions(config.directory);
			if (sessRes.success && sessRes.data) {
				dispatch({
					type: "MERGE_PROJECT_SESSIONS",
					payload: {
						directory: config.directory,
						sessions: sessRes.data as Session[],
					},
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
			if (loadedResourceDirectoryRef.current === null) {
				await loadServerResources(config.directory);
			}
			const worktreeParentMap = getWorktreeParents();
			const isWorktree = Boolean(worktreeParentMap[config.directory]);
			const workspaceDirectory = isWorktree
				? worktreeParentMap[config.directory]?.parentDir
				: config.directory;
			const currentWorkspace = stateRef.current.workspaces.find(
				(workspace) => workspace.id === workspaceId,
			);
			if (currentWorkspace && workspaceDirectory) {
				const nextProjects = new Set(currentWorkspace.projects);
				nextProjects.add(workspaceDirectory);
				const nextWorkspaces = stateRef.current.workspaces.map((workspace) =>
					workspace.id === workspaceId
						? normalizeWorkspace({
								...workspace,
								serverUrl: config.baseUrl,
								username: config.username ?? workspace.username,
								projects: [...nextProjects],
							})
						: workspace,
				);
				dispatch({ type: "SET_WORKSPACES", payload: nextWorkspaces });
			}
			if (workspaceDirectory) {
				if (workspaceId === LOCAL_WORKSPACE_ID) {
					storageSet(STORAGE_KEYS.SERVER_URL, config.baseUrl);
					storageSet(STORAGE_KEYS.DIRECTORY, workspaceDirectory);
					storageSetOrRemove(STORAGE_KEYS.USERNAME, config.username);
				}
			}
			// Update recent projects only for the workspace root, not worktrees.
			if (config.directory && !isWorktree) {
				const updated = addRecentProject({
					directory: config.directory,
					serverUrl: config.baseUrl,
					username: config.username,
					lastConnected: Date.now(),
				});
				dispatch({ type: "SET_RECENT_PROJECTS", payload: updated });
			}
		},
		[bridge, loadServerResources],
	);

	const removeProject = useCallback(
		async (directory: string) => {
			if (!bridge) return;
			const worktreeParentMap = getWorktreeParents();
			const workspaceDirectory = getWorkspaceRootDirectory(
				directory,
				worktreeParentMap,
			);
			const directoriesToRemove =
				workspaceDirectory === directory
					? [
							workspaceDirectory,
							...Object.entries(worktreeParentMap)
								.filter(([, meta]) => meta.parentDir === workspaceDirectory)
								.map(([worktreeDir]) => worktreeDir),
						]
					: [directory];

			for (const dir of directoriesToRemove) {
				expectedDirectoriesRef.current.delete(dir);
				await bridge.removeProject(dir);
				dispatch({ type: "REMOVE_PROJECT", payload: dir });
			}

			if (workspaceDirectory === directory) {
				const remainingRootDirectories = Object.keys(state.connections).filter(
					(dir) =>
						dir !== directory &&
						!directoriesToRemove.includes(dir) &&
						!worktreeParentMap[dir],
				);
				const nextRoot = remainingRootDirectories[0] ?? null;
				if (nextRoot) {
					storageSet(STORAGE_KEYS.DIRECTORY, nextRoot);
				} else {
					storageRemove(STORAGE_KEYS.DIRECTORY);
				}
			}
			// If the active session belongs to this project, clear it
			const activeSession = state.sessions.find(
				(s) => s.id === state.activeSessionId,
			);
			if (
				(activeSession?._projectDir ?? activeSession?.directory) === directory
			) {
				dispatch({ type: "SET_ACTIVE_SESSION", payload: null });
			}
		},
		[bridge, state.connections, state.sessions, state.activeSessionId],
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
								logs: startRes.logs,
							},
						});
						return;
					}
				}
			}

			if (cancelled) return;
			dispatch({ type: "SET_ERROR", payload: null });
			try {
				const worktreeParentMap = getWorktreeParents();
				const bootWorkspaces = stateRef.current.workspaces.map((workspace) =>
					workspace.id === LOCAL_WORKSPACE_ID && detachedProject
						? { ...workspace, projects: [detachedProject] }
						: workspace,
				);

				// Collect all project configs upfront so we can connect in parallel
				const allProjectConfigs: Array<{
					workspaceId: string;
					baseUrl: string;
					directory: string;
					username?: string;
				}> = [];

				for (const workspace of bootWorkspaces) {
					for (const project of workspace.projects) {
						const rootDirectory = getWorkspaceRootDirectory(
							project,
							worktreeParentMap,
						);
						const relatedWorktrees = Object.entries(worktreeParentMap)
							.filter(([, meta]) => meta.parentDir === rootDirectory)
							.map(([worktreeDir]) => worktreeDir);
						expectedDirectoriesRef.current = new Set([
							...expectedDirectoriesRef.current,
							rootDirectory,
							...relatedWorktrees,
						]);
						const baseConfig = {
							workspaceId: workspace.id,
							baseUrl: workspace.serverUrl,
							username: workspace.username,
						};
						allProjectConfigs.push({
							...baseConfig,
							directory: rootDirectory,
						});
						for (const worktreeDir of relatedWorktrees) {
							allProjectConfigs.push({
								...baseConfig,
								directory: worktreeDir,
							});
						}
					}
				}

				// Connect all projects in parallel instead of sequentially
				await Promise.allSettled(
					allProjectConfigs.map((config) =>
						addProject(config, { suppressError: true }),
					),
				);
			} catch {
				/* ignore localStorage errors */
			}

			if (cancelled) return;
			dispatch({ type: "SET_BOOT_STATE", payload: { state: "ready" } });
		};

		void bootstrap();

		return () => {
			cancelled = true;
		};
	}, [bridge, addProject, detachedProject]);

	const activeWorkspace = useMemo(
		() =>
			state.workspaces.find(
				(workspace) => workspace.id === state.activeWorkspaceId,
			) ??
			state.workspaces[0] ??
			null,
		[state.workspaces, state.activeWorkspaceId],
	);

	const activeWorkspaceProjectSet = useMemo(() => {
		const directories = new Set<string>();
		if (!activeWorkspace) return directories;
		for (const project of activeWorkspace.projects) {
			directories.add(project);
		}
		for (const [directory, workspaceId] of Object.entries(
			state.projectWorkspaceMap,
		)) {
			if (workspaceId === activeWorkspace.id) {
				directories.add(directory);
			}
		}
		return directories;
	}, [activeWorkspace, state.projectWorkspaceMap]);

	const activeWorkspaceConnections = useMemo(
		() =>
			Object.fromEntries(
				Object.entries(state.connections).filter(([directory]) =>
					activeWorkspaceProjectSet.has(directory),
				),
			),
		[state.connections, activeWorkspaceProjectSet],
	);

	const activeWorkspaceSessions = useMemo(
		() =>
			state.sessions.filter((session) => {
				const directory = session._projectDir ?? session.directory;
				return activeWorkspaceProjectSet.has(directory);
			}),
		[state.sessions, activeWorkspaceProjectSet],
	);

	const workspaceDirectory = useMemo(() => {
		const connectedDirectories = Object.entries(activeWorkspaceConnections)
			.filter(([, status]) => status.state === "connected")
			.map(([directory]) => directory);
		const rootDirectories = connectedDirectories.filter(
			(directory) => !state.worktreeParents[directory],
		);
		if (rootDirectories.length > 0) return rootDirectories[0] ?? null;
		if (connectedDirectories.length > 0) {
			return getWorkspaceRootDirectory(
				connectedDirectories[0]!,
				state.worktreeParents,
			);
		}
		return state.draftSessionDirectory &&
			activeWorkspaceProjectSet.has(state.draftSessionDirectory)
			? getWorkspaceRootDirectory(
					state.draftSessionDirectory,
					state.worktreeParents,
				)
			: null;
	}, [
		activeWorkspaceConnections,
		activeWorkspaceProjectSet,
		state.worktreeParents,
		state.draftSessionDirectory,
	]);

	const workspaceConnection = useMemo(() => {
		if (workspaceDirectory) {
			return activeWorkspaceConnections[workspaceDirectory] ?? null;
		}
		if (!activeWorkspace) return null;
		return {
			state: "idle",
			serverUrl: activeWorkspace.serverUrl,
			serverVersion: null,
			error: null,
			lastEventAt: null,
		} satisfies ConnectionStatus;
	}, [activeWorkspaceConnections, workspaceDirectory, activeWorkspace]);

	const connectedDirectorySet = useMemo(
		() => new Set(Object.keys(state.connections)),
		[state.connections],
	);

	const activeResourceDirectory = useMemo(() => {
		const activeSession = state.sessions.find(
			(session) => session.id === state.activeSessionId,
		);
		const sessionDirectory = getSessionDirectory(activeSession);
		if (sessionDirectory) return sessionDirectory;
		if (state.draftSessionDirectory) return state.draftSessionDirectory;

		return workspaceDirectory;
	}, [
		state.sessions,
		state.activeSessionId,
		state.draftSessionDirectory,
		workspaceDirectory,
	]);

	useEffect(() => {
		if (!bridge || !activeResourceDirectory) return;
		if (loadedResourceDirectoryRef.current === activeResourceDirectory) return;
		void loadServerResources(activeResourceDirectory);
	}, [bridge, activeResourceDirectory, loadServerResources]);

	const disconnect = useCallback(async () => {
		if (!bridge) return;
		await bridge.disconnect();
		expectedDirectoriesRef.current.clear();
		storageRemove(STORAGE_KEYS.DIRECTORY);
		loadedResourceDirectoryRef.current = null;
		dispatch({ type: "CLEAR_ALL_PROJECTS" });
	}, [bridge]);

	const openDirectory = useCallback(async (): Promise<string | null> => {
		if (!activeWorkspace?.isLocal) return null;
		return window.electronAPI?.openDirectory?.() ?? null;
	}, [activeWorkspace?.isLocal]);

	const connectToProject = useCallback(
		async (
			directory: string,
			serverUrl?: string,
			usernameOverride?: string,
			passwordOverride?: string,
		) => {
			const trimmedDirectory = directory.trim();
			if (!trimmedDirectory) return;
			const workspace =
				stateRef.current.workspaces.find(
					(item) => item.id === stateRef.current.activeWorkspaceId,
				) ?? createLocalWorkspace();
			const url = serverUrl ?? workspace.serverUrl ?? DEFAULT_SERVER_URL;
			const username = usernameOverride ?? workspace.username ?? undefined;
			const password = passwordOverride;
			const workspaceId = workspace.id;
			const worktreeParentMap = getWorktreeParents();
			const targetWorkspace = getWorkspaceRootDirectory(
				trimmedDirectory,
				worktreeParentMap,
			);
			const relatedWorktrees = Object.entries(worktreeParentMap)
				.filter(([, meta]) => meta.parentDir === targetWorkspace)
				.map(([worktreeDir]) => worktreeDir);
			const desiredDirectories = [targetWorkspace, ...relatedWorktrees];
			const activeWorkspaceProjects = new Set(workspace.projects);

			if (activeWorkspaceProjects.has(targetWorkspace)) {
				expectedDirectoriesRef.current = new Set([
					...expectedDirectoriesRef.current,
					...desiredDirectories,
				]);
				const missingDirectories = desiredDirectories.filter(
					(dir) => !connectedDirectorySet.has(dir),
				);
				await Promise.allSettled(
					missingDirectories.map((dir) =>
						addProject({
							workspaceId,
							baseUrl: url,
							directory: dir,
							username: username || undefined,
							password: password || undefined,
						}),
					),
				);
				return;
			}

			expectedDirectoriesRef.current = new Set([
				...expectedDirectoriesRef.current,
				...desiredDirectories,
			]);
			await addProject({
				workspaceId,
				baseUrl: url,
				directory: targetWorkspace,
				username: username || undefined,
				password: password || undefined,
			});

			await Promise.allSettled(
				relatedWorktrees
					.filter((worktreeDir) => worktreeDir !== targetWorkspace)
					.map((worktreeDir) =>
						addProject({
							workspaceId,
							baseUrl: url,
							directory: worktreeDir,
							username: username || undefined,
							password: password || undefined,
						}),
					),
			);
			if (workspaceId === LOCAL_WORKSPACE_ID) {
				storageSet(STORAGE_KEYS.DIRECTORY, targetWorkspace);
				if (username) {
					storageSet(STORAGE_KEYS.USERNAME, username);
				} else {
					storageRemove(STORAGE_KEYS.USERNAME);
				}
				storageSet(STORAGE_KEYS.SERVER_URL, url);
			}
		},
		[addProject, connectedDirectorySet],
	);

	const refreshSessions = useCallback(async () => {
		if (!bridge) return;
		const res = await bridge.listSessions();
		if (res.success && res.data) {
			dispatch({ type: "SET_SESSIONS", payload: res.data });
		}
	}, [bridge]);

	// Single ref to avoid stale closures and prevent unnecessary callback recreation
	const stateRef = useRef(state);
	stateRef.current = state;

	/** Best-effort cleanup of a temporary session if it exists. */
	const cleanupTemporarySession = useCallback(
		(excludeId?: string | null) => {
			const prevId = stateRef.current.activeSessionId;
			if (
				prevId &&
				prevId !== excludeId &&
				stateRef.current.temporarySessions.has(prevId)
			) {
				dispatch({ type: "SESSION_DELETED", payload: prevId });
				bridge?.deleteSession(prevId).catch(() => {
					/* best-effort cleanup of temporary session */
				});
			}
		},
		[bridge],
	);

	const fetchMessagePage = useCallback(
		async (
			sessionId: string,
			options?: { before?: string; limit?: number },
		) => {
			if (!bridge) return { messages: [], hasMore: false, nextCursor: null };
			const pageSize = options?.limit ?? MESSAGE_PAGE_SIZE;
			const res = await bridge.getMessages(sessionId, {
				limit: pageSize,
				before: options?.before,
			});
			const data = res.success && res.data ? res.data : null;
			const messages = data?.messages ?? [];
			const nextCursor = data?.nextCursor ?? null;
			return {
				messages,
				hasMore: nextCursor !== null || messages.length >= pageSize,
				nextCursor,
			};
		},
		[bridge],
	);

	const hydrateChildSessionsForMessages = useCallback(
		(
			messages: MessageEntry[],
			options?: { requestId?: number; sessionId?: string },
		) => {
			if (!bridge || messages.length === 0) return;

			const childSessionIds = new Set<string>();
			for (const msg of messages) {
				for (const part of msg.parts) {
					const childSid = getChildSessionId(part);
					if (childSid) childSessionIds.add(childSid);
				}
			}

			for (const childSid of childSessionIds) {
				const nextVersion =
					(childHydrationVersionRef.current[childSid] ?? 0) + 1;
				childHydrationVersionRef.current[childSid] = nextVersion;
				bridge
					.getMessages(childSid, { limit: 10000 })
					.then((childRes) => {
						if (childHydrationVersionRef.current[childSid] !== nextVersion) {
							return;
						}
						if (
							options?.requestId !== undefined &&
							options.requestId !== selectSessionRequestRef.current
						) {
							return;
						}
						if (
							options?.sessionId &&
							options.sessionId !== stateRef.current.activeSessionId
						) {
							return;
						}
						const childMessages = childRes.success
							? childRes.data?.messages
							: undefined;
						if (childMessages) {
							dispatch({
								type: "LOAD_CHILD_SESSION",
								payload: {
									childSessionId: childSid,
									messages: childMessages,
								},
							});
						}
					})
					.catch(() => {
						/* best-effort child session fetch */
					});
			}
		},
		[bridge],
	);

	const selectSession = useCallback(
		async (id: string | null) => {
			if (id === stateRef.current.activeSessionId) return;

			cleanupTemporarySession(id);

			// Check if we have a cached buffer BEFORE dispatching (dispatch consumes it).
			// Extract messages from the buffer now because stateRef won't reflect the
			// new reducer state until the next render, and we need the correct
			// messages for child-session hydration.
			const bufferSnapshot = id
				? stateRef.current._sessionBuffers[id]
				: undefined;
			const hadCachedBuffer = !!bufferSnapshot;
			let bufferMessages: MessageEntry[] | undefined;
			if (bufferSnapshot) {
				bufferMessages = Object.values(bufferSnapshot.messages).map(
					(entry) => ({
						info: entry.info,
						parts: Object.values(entry.parts).map((p) =>
							tagPartWithDeltaPositions(p),
						),
					}),
				);
			}

			const requestId = ++selectSessionRequestRef.current;
			dispatch({ type: "SET_ACTIVE_SESSION", payload: id });
			if (!id || !bridge) return;

			if (hadCachedBuffer && bufferMessages) {
				// Buffer was consumed and displayed instantly by SET_ACTIVE_SESSION
				// (which also set isLoadingMessages to false). Just hydrate child
				// sessions from the pre-extracted buffer messages.
				hydrateChildSessionsForMessages(bufferMessages, {
					requestId,
					sessionId: id,
				});
				return;
			}

			const { messages, hasMore, nextCursor } = await fetchMessagePage(id);
			if (requestId !== selectSessionRequestRef.current) return;
			dispatch({
				type: "SET_MESSAGES",
				payload: { messages, hasMore, nextCursor },
			});
			hydrateChildSessionsForMessages(messages, { requestId, sessionId: id });
		},
		[
			bridge,
			cleanupTemporarySession,
			fetchMessagePage,
			hydrateChildSessionsForMessages,
		],
	);

	const loadOlderMessages = useCallback(async (): Promise<boolean> => {
		const {
			activeSessionId,
			messages,
			isLoadingOlderMessages,
			messageHistoryHasMore,
			messageHistoryCursor,
		} = stateRef.current;
		if (
			!bridge ||
			!activeSessionId ||
			isLoadingOlderMessages ||
			!messageHistoryHasMore ||
			!messageHistoryCursor ||
			messages.length === 0
		) {
			return false;
		}

		dispatch({ type: "SET_LOADING_OLDER_MESSAGES", payload: true });

		try {
			const {
				messages: olderMessages,
				hasMore,
				nextCursor,
			} = await fetchMessagePage(activeSessionId, {
				before: messageHistoryCursor,
			});
			// Ensure we are still on the same session
			if (stateRef.current.activeSessionId !== activeSessionId) return false;
			dispatch({
				type: "SET_MESSAGES",
				payload: {
					messages: olderMessages,
					hasMore,
					nextCursor,
					mode: "prepend",
				},
			});
			return hasMore;
		} catch {
			dispatch({ type: "SET_LOADING_OLDER_MESSAGES", payload: false });
			return false;
		}
	}, [bridge, fetchMessagePage]);

	const loadNewerMessages = useCallback(async (): Promise<boolean> => {
		return false;
	}, []);

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
			// Read from ref to avoid stale closures and, more importantly,
			// to keep this callback's identity stable (deps don't include
			// state.sessions / state.activeSessionId).
			const currentSessions = stateRef.current.sessions;
			const currentActiveId = stateRef.current.activeSessionId;

			// Before removing, check if this session belongs to a worktree
			// and whether it's the last session there.
			const deletedSession = currentSessions.find((s) => s.id === id);
			const deletedDir =
				deletedSession?._projectDir ?? deletedSession?.directory;
			const wtMeta = deletedDir
				? stateRef.current.worktreeParents[deletedDir]
				: undefined;

			// Determine next session *before* removing the deleted one from state
			const needsSwitch = currentActiveId === id;
			const nextId = needsSwitch
				? (() => {
						const idx = currentSessions.findIndex((s) => s.id === id);
						const next =
							currentSessions[idx + 1] ?? currentSessions[idx - 1] ?? null;
						return next?.id ?? null;
					})()
				: null;

			// Optimistic removal first - avoids the one-frame gap where the
			// deleted session is still visible but already deselected
			dispatch({ type: "SESSION_DELETED", payload: id });

			// Then switch to the adjacent session (runs against the already-
			// pruned list so there is no flicker)
			if (needsSwitch && nextId) {
				void selectSession(nextId);
			}

			bridge.deleteSession(id).catch(() => {
				/* best-effort deletion */
			});

			// If the deleted session was in a worktree, check if it was the last one
			if (deletedDir && wtMeta) {
				const remaining = currentSessions.filter(
					(s) => s.id !== id && (s._projectDir ?? s.directory) === deletedDir,
				);
				if (remaining.length === 0) {
					dispatch({
						type: "SET_PENDING_WORKTREE_CLEANUP",
						payload: {
							worktreeDir: deletedDir,
							parentDir: wtMeta.parentDir,
						},
					});
				}
			}
		},
		[bridge, selectSession],
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

	/**
	 * Ensure a session exists, creating one from a draft if needed.
	 * Returns the session ID or null if no session is available.
	 */
	const ensureSessionFromDraft = useCallback(async (): Promise<
		string | null
	> => {
		let sessionId = stateRef.current.activeSessionId;
		const draftDirectory = stateRef.current.draftSessionDirectory;
		if (!sessionId && draftDirectory) {
			if (draftCreatingRef.current) return null;
			draftCreatingRef.current = true;
			const wasTemporary = stateRef.current.draftIsTemporary;
			try {
				const newSession = await createSession(undefined, draftDirectory);
				if (!newSession) {
					draftCreatingRef.current = false;
					return null;
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
				return null;
			}
			draftCreatingRef.current = false;
		}
		if (!sessionId) {
			dispatch({
				type: "SET_ERROR",
				payload: "Select or create a session first.",
			});
			return null;
		}
		return sessionId;
	}, [createSession]);

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
			const queue = stateRef.current.queuedPrompts[sessionId];
			if (!queue || queue.length === 0) return;

			dispatchingRef.current.add(sessionId);
			try {
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
			} finally {
				dispatchingRef.current.delete(sessionId);
			}
		},
		[dispatchPromptDirect],
	);

	const sendPrompt = useCallback(
		async (text: string, images?: string[], mode?: QueueMode) => {
			if (!bridge) return;
			const sessionId = await ensureSessionFromDraft();
			if (!sessionId) return;

			const effectiveMode = mode ?? "queue";

			// If session is busy, enqueue instead of sending directly.
			// Read from ref to avoid stale closures when the user switches
			// model/agent/variant right before pressing Enter.
			if (stateRef.current.busySessionIds.has(sessionId)) {
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
					mode: effectiveMode,
				};

				if (effectiveMode === "interrupt" || effectiveMode === "after-part") {
					// Enqueue at front for both interrupt and after-part modes
					dispatch({
						type: "QUEUE_ADD",
						payload: { sessionID: sessionId, prompt: queued },
					});
					const existingQueue = stateRef.current.queuedPrompts[sessionId] ?? [];
					if (existingQueue.length > 0) {
						dispatch({
							type: "QUEUE_REORDER",
							payload: {
								sessionID: sessionId,
								fromIndex: existingQueue.length,
								toIndex: 0,
							},
						});
					}
					if (effectiveMode === "interrupt") {
						await bridge.abort(sessionId);
					} else {
						dispatch({
							type: "SET_AFTER_PART_PENDING",
							payload: { sessionID: sessionId, pending: true },
						});
					}
				} else {
					// Queue (default): enqueue at end, wait for session to become idle.
					dispatch({
						type: "QUEUE_ADD",
						payload: { sessionID: sessionId, prompt: queued },
					});
				}
				return;
			}

			await dispatchPromptDirect(sessionId, text, images);
		},
		[bridge, dispatchPromptDirect, ensureSessionFromDraft],
	);

	const findFiles = useCallback(
		async (directory: string | null, query: string): Promise<string[]> => {
			if (!bridge) return [];
			const res = await bridge.findFiles(directory, query);
			if (!res.success) {
				console.error("[findFiles] bridge request failed", {
					directory,
					query,
					error: res.error,
				});
				return [];
			}
			return res.data ?? [];
		},
		[bridge],
	);

	const sendCommand = useCallback(
		async (command: string, args: string) => {
			if (!bridge) return;
			const sessionId = await ensureSessionFromDraft();
			if (!sessionId) return;

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
					payload: getErrorMessage(err),
				});
			}
		},
		[
			bridge,
			state.selectedModel,
			state.selectedAgent,
			currentVariant,
			ensureSessionFromDraft,
		],
	);

	// Auto-dispatch queued prompts when a session transitions from busy to idle.
	// Builds a synthetic trigger map (sessionID -> true) for newly-idle sessions
	// so the generic useDesktopNotification hook can handle the notification.
	const prevBusyRef = useRef<Set<string>>(new Set());
	const justIdledMap = useRef<Record<string, true>>({});
	useEffect(() => {
		const prevBusy = prevBusyRef.current;
		const nowBusy = state.busySessionIds;
		const newlyIdle: Record<string, true> = {};

		for (const sessionId of prevBusy) {
			if (!nowBusy.has(sessionId)) {
				void dispatchNextQueued(sessionId);
				newlyIdle[sessionId] = true;
			}
		}

		justIdledMap.current = newlyIdle;
		prevBusyRef.current = new Set(nowBusy);
	}, [state.busySessionIds, dispatchNextQueued]);

	// After-part trigger: when the reducer detects a part just finished while
	// an "after-part" prompt is pending, it adds the sessionID to
	// _afterPartTriggered.  This effect picks it up, aborts the session, and
	// the abort causes busy->idle which dispatches the queued prompt above.
	useEffect(() => {
		if (state._afterPartTriggered.size === 0) return;
		for (const sessionId of state._afterPartTriggered) {
			dispatch({
				type: "CLEAR_AFTER_PART_TRIGGERED",
				payload: { sessionID: sessionId },
			});
			if (bridge) {
				void bridge.abort(sessionId);
			}
		}
	}, [state._afterPartTriggered, bridge]);

	// Desktop notifications for newly-idle sessions
	useDesktopNotification(
		justIdledMap.current,
		"Session complete",
		state.activeSessionId,
		state.sessions,
		selectSession,
	);

	// Desktop notification when a question arrives for a non-active session
	useDesktopNotification(
		state.pendingQuestions,
		"Question waiting",
		state.activeSessionId,
		state.sessions,
		selectSession,
	);

	// Desktop notification when a permission is requested for a non-active session
	useDesktopNotification(
		state.pendingPermissions,
		"Permission requested",
		state.activeSessionId,
		state.sessions,
		selectSession,
	);

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
			try {
				const res = await bridge.replyQuestion(pending.id, answers);
				if (!res.success) {
					dispatch({
						type: "SET_ERROR",
						payload: res.error ?? "Failed to submit question reply",
					});
				}
			} catch (error) {
				dispatch({
					type: "SET_ERROR",
					payload:
						error instanceof Error
							? error.message
							: "Failed to submit question reply",
				});
			}
		},
		[bridge, state.pendingQuestions, state.activeSessionId],
	);

	const rejectQuestion = useCallback(async () => {
		if (!bridge || !state.activeSessionId) return;
		const pending = state.pendingQuestions[state.activeSessionId];
		if (!pending) return;
		try {
			const res = await bridge.rejectQuestion(pending.id);
			if (!res.success) {
				dispatch({
					type: "SET_ERROR",
					payload: res.error ?? "Failed to dismiss question",
				});
			}
		} catch (error) {
			dispatch({
				type: "SET_ERROR",
				payload:
					error instanceof Error ? error.message : "Failed to dismiss question",
			});
		}
	}, [bridge, state.pendingQuestions, state.activeSessionId]);

	const startDraftSession = useCallback(
		(directory: string) => {
			cleanupTemporarySession();
			dispatch({ type: "START_DRAFT_SESSION", payload: directory });
		},
		[cleanupTemporarySession],
	);

	const setDraftDirectory = useCallback((directory: string) => {
		dispatch({ type: "SET_DRAFT_DIRECTORY", payload: directory });
	}, []);

	const setDraftTemporary = useCallback((temporary: boolean) => {
		dispatch({ type: "SET_DRAFT_TEMPORARY", payload: temporary });
	}, []);

	/** Re-fetch providers from the server and update global state. */
	const refreshProviders = useCallback(async () => {
		await loadServerResources(
			activeResourceDirectory ?? loadedResourceDirectoryRef.current,
		);
	}, [activeResourceDirectory, loadServerResources]);

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

			if (stateRef.current.busySessionIds.has(sessionId)) {
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

	const setSessionDraft = useCallback((key: string, text: string) => {
		dispatch({ type: "SET_SESSION_DRAFT", payload: { key, text } });
	}, []);

	const clearSessionDraft = useCallback((key: string) => {
		dispatch({ type: "CLEAR_SESSION_DRAFT", payload: key });
	}, []);

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
				const refreshed = await fetchMessagePage(state.activeSessionId);
				dispatch({
					type: "SET_MESSAGES",
					payload: {
						messages: refreshed.messages,
						hasMore: refreshed.hasMore,
						nextCursor: refreshed.nextCursor,
					},
				});
			} catch (err) {
				dispatch({
					type: "SET_ERROR",
					payload:
						err instanceof Error ? err.message : "Failed to revert session",
				});
			}
		},
		[bridge, fetchMessagePage, state.activeSessionId, state.busySessionIds],
	);

	const unrevert = useCallback(async () => {
		if (!bridge || !state.activeSessionId) return;
		try {
			const res = await bridge.unrevertSession(state.activeSessionId);
			if (res.success && res.data) {
				dispatch({ type: "SESSION_UPDATED", payload: res.data });
			}
			// Re-fetch messages to include the restored messages
			const refreshed = await fetchMessagePage(state.activeSessionId);
			dispatch({
				type: "SET_MESSAGES",
				payload: {
					messages: refreshed.messages,
					hasMore: refreshed.hasMore,
					nextCursor: refreshed.nextCursor,
				},
			});
		} catch (err) {
			dispatch({
				type: "SET_ERROR",
				payload:
					err instanceof Error ? err.message : "Failed to unrevert session",
			});
		}
	}, [bridge, fetchMessagePage, state.activeSessionId]);

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
		(worktreeDir: string, parentDir: string, branch: string) => {
			dispatch({
				type: "REGISTER_WORKTREE",
				payload: { worktreeDir, parentDir, branch },
			});
		},
		[],
	);

	const unregisterWorktree = useCallback((worktreeDir: string) => {
		dispatch({ type: "UNREGISTER_WORKTREE", payload: worktreeDir });
	}, []);

	const touchWorktree = useCallback((worktreeDir: string) => {
		dispatch({ type: "TOUCH_WORKTREE", payload: worktreeDir });
	}, []);

	const clearWorktreeCleanup = useCallback(() => {
		dispatch({ type: "SET_PENDING_WORKTREE_CLEANUP", payload: null });
	}, []);

	const createWorkspace = useCallback(
		(input: { name: string; serverUrl: string; username?: string }) => {
			const id = `ws_${Date.now().toString(36)}`;
			const workspace = normalizeWorkspace({
				id,
				name: input.name,
				serverUrl: input.serverUrl,
				username: input.username,
				isLocal: false,
				projects: [],
				selectedModel: null,
				selectedAgent: null,
				lastActiveSessionId: null,
			});
			dispatch({
				type: "SET_WORKSPACES",
				payload: [...stateRef.current.workspaces, workspace],
			});
			dispatch({ type: "SET_ACTIVE_WORKSPACE", payload: workspace.id });
			dispatch({ type: "SET_ACTIVE_SESSION", payload: null });
		},
		[],
	);

	const updateWorkspace = useCallback(
		(
			workspaceId: string,
			input: Partial<Pick<Workspace, "name" | "serverUrl" | "username">>,
		) => {
			const next = stateRef.current.workspaces.map((workspace) => {
				if (workspace.id !== workspaceId) return workspace;
				const nextServerUrl = workspace.isLocal
					? DEFAULT_SERVER_URL
					: (input.serverUrl ?? workspace.serverUrl);
				return normalizeWorkspace({
					...workspace,
					name: input.name ?? workspace.name,
					serverUrl: nextServerUrl,
					username: input.username ?? workspace.username,
				});
			});
			dispatch({ type: "SET_WORKSPACES", payload: next });
		},
		[],
	);

	const switchWorkspace = useCallback(
		(workspaceId: string) => {
			const workspace = stateRef.current.workspaces.find(
				(item) => item.id === workspaceId,
			);
			dispatch({ type: "SET_ACTIVE_WORKSPACE", payload: workspaceId });
			void selectSession(workspace?.lastActiveSessionId ?? null);
		},
		[selectSession],
	);

	const removeWorkspace = useCallback(
		async (workspaceId: string) => {
			if (workspaceId === LOCAL_WORKSPACE_ID || !bridge) return;
			const workspace = stateRef.current.workspaces.find(
				(item) => item.id === workspaceId,
			);
			if (!workspace) return;
			for (const directory of workspace.projects) {
				await bridge.removeProject(directory);
				dispatch({ type: "REMOVE_PROJECT", payload: directory });
			}
			const nextWorkspaces = stateRef.current.workspaces.filter(
				(item) => item.id !== workspaceId,
			);
			dispatch({ type: "SET_WORKSPACES", payload: nextWorkspaces });
			if (stateRef.current.activeWorkspaceId === workspaceId) {
				const nextWorkspace = nextWorkspaces[0] ?? null;
				dispatch({
					type: "SET_ACTIVE_WORKSPACE",
					payload: nextWorkspace?.id ?? LOCAL_WORKSPACE_ID,
				});
				void selectSession(nextWorkspace?.lastActiveSessionId ?? null);
			}
		},
		[bridge, selectSession],
	);

	// ----- Split context values (memoised per domain) -----

	const sessionCtx = useMemo<SessionContextValue>(
		() => ({
			sessions: activeWorkspaceSessions,
			activeSessionId:
				state.activeSessionId &&
				activeWorkspaceSessions.some(
					(session) => session.id === state.activeSessionId,
				)
					? state.activeSessionId
					: null,
			messages: state.messages,
			isBusy: state.isBusy,
			isLoadingMessages: state.isLoadingMessages,
			busySessionIds: state.busySessionIds,
			queuedPrompts: state.queuedPrompts,
			pendingPermissions: state.pendingPermissions,
			pendingQuestions: state.pendingQuestions,
			draftSessionDirectory: state.draftSessionDirectory,
			draftIsTemporary: state.draftIsTemporary,
			temporarySessions: state.temporarySessions,
			unreadSessionIds: state.unreadSessionIds,
			sessionDrafts: state.sessionDrafts,
			sessionMeta: state.sessionMeta,
			childSessions: state.childSessions,
			recentProjects: state.recentProjects,
		}),
		[
			activeWorkspaceSessions,
			state.activeSessionId,
			state.messages,
			state.isBusy,
			state.isLoadingMessages,
			state.busySessionIds,
			state.queuedPrompts,
			state.pendingPermissions,
			state.pendingQuestions,
			state.draftSessionDirectory,
			state.draftIsTemporary,
			state.temporarySessions,
			state.unreadSessionIds,
			state.sessionDrafts,
			state.sessionMeta,
			state.childSessions,
			state.recentProjects,
		],
	);

	const messagesCtx = useMemo<MessagesContextValue>(
		() => ({
			messages: state.messages,
			childSessions: state.childSessions,
			messageHistoryHasMore: state.messageHistoryHasMore,
			messageWindowHasNewer: state.messageWindowHasNewer,
			isLoadingOlderMessages: state.isLoadingOlderMessages,
			isLoadingNewerMessages: state.isLoadingNewerMessages,
		}),
		[
			state.messages,
			state.childSessions,
			state.messageHistoryHasMore,
			state.messageWindowHasNewer,
			state.isLoadingOlderMessages,
			state.isLoadingNewerMessages,
		],
	);

	const modelCtx = useMemo<ModelContextValue>(
		() => ({
			providers: state.providers,
			providerDefaults: state.providerDefaults,
			selectedModel: state.selectedModel,
			agents: state.agents,
			selectedAgent: state.selectedAgent,
			variantSelections: state.variantSelections,
			commands: state.commands,
			currentVariant,
		}),
		[
			state.providers,
			state.providerDefaults,
			state.selectedModel,
			state.agents,
			state.selectedAgent,
			state.variantSelections,
			state.commands,
			currentVariant,
		],
	);

	const connectionCtx = useMemo<ConnectionContextValue>(
		() => ({
			workspaces: state.workspaces,
			activeWorkspace,
			activeWorkspaceId: state.activeWorkspaceId,
			workspaceStatuses: Object.fromEntries(
				state.workspaces.map((workspace) => {
					const workspaceSessions = state.sessions.filter((session) => {
						const directory = session._projectDir ?? session.directory;
						return (
							workspace.projects.includes(directory) ||
							state.projectWorkspaceMap[directory] === workspace.id
						);
					});
					const sessionIds = new Set(
						workspaceSessions.map((session) => session.id),
					);
					const workspaceConnections = Object.entries(state.connections).filter(
						([directory]) =>
							workspace.projects.includes(directory) ||
							state.projectWorkspaceMap[directory] === workspace.id,
					);
					return [
						workspace.id,
						{
							busy: [...state.busySessionIds].some((id) => sessionIds.has(id)),
							needsAttention:
								Object.keys(state.pendingPermissions).some((id) =>
									sessionIds.has(id),
								) ||
								Object.keys(state.pendingQuestions).some((id) =>
									sessionIds.has(id),
								),
							error: workspaceConnections.some(
								([, status]) => status.state === "error",
							),
							connected: workspaceConnections.some(
								([, status]) => status.state === "connected",
							),
						},
					] as const;
				}),
			),
			connections: activeWorkspaceConnections,
			workspaceDirectory,
			workspaceServerUrl:
				activeWorkspace?.serverUrl ?? workspaceConnection?.serverUrl ?? null,
			workspaceUsername: activeWorkspace?.username ?? null,
			isLocalWorkspace: activeWorkspace?.isLocal ?? isLocalServer(),
			activeDirectory: activeResourceDirectory,
			bootState: state.bootState,
			bootError: state.bootError,
			bootLogs: state.bootLogs,
			lastError: state.lastError,
			worktreeParents: state.worktreeParents,
			pendingWorktreeCleanup: state.pendingWorktreeCleanup,
		}),
		[
			state.workspaces,
			activeWorkspace,
			state.activeWorkspaceId,
			state.sessions,
			state.connections,
			state.projectWorkspaceMap,
			state.busySessionIds,
			state.pendingPermissions,
			state.pendingQuestions,
			activeWorkspaceConnections,
			workspaceDirectory,
			workspaceConnection,
			activeResourceDirectory,
			state.bootState,
			state.bootError,
			state.bootLogs,
			state.lastError,
			state.worktreeParents,
			state.pendingWorktreeCleanup,
		],
	);

	const actionsCtx = useMemo<ActionsContextValue>(
		() => ({
			addProject,
			removeProject,
			disconnect,
			selectSession,
			loadOlderMessages,
			loadNewerMessages,
			createSession,
			deleteSession,
			renameSession,
			sendPrompt,
			findFiles,
			sendCommand,
			abortSession,
			respondPermission,
			replyQuestion,
			rejectQuestion,
			setModel,
			setAgent,
			cycleVariant: doCycleVariant,
			clearError,
			refreshProviders,
			refreshSessions,
			getQueuedPrompts,
			removeFromQueue,
			reorderQueue,
			updateQueuedPrompt,
			sendQueuedNow,
			setSessionDraft,
			clearSessionDraft,
			openDirectory,
			connectToProject,
			startDraftSession,
			setDraftDirectory,
			setDraftTemporary,
			revertToMessage,
			unrevert,
			forkFromMessage,
			setSessionColor,
			setSessionTags,
			registerWorktree,
			unregisterWorktree,
			touchWorktree,
			clearWorktreeCleanup,
			createWorkspace,
			updateWorkspace,
			removeWorkspace,
			switchWorkspace,
		}),
		[
			addProject,
			removeProject,
			disconnect,
			selectSession,
			loadOlderMessages,
			loadNewerMessages,
			createSession,
			deleteSession,
			renameSession,
			sendPrompt,
			findFiles,
			sendCommand,
			abortSession,
			respondPermission,
			replyQuestion,
			rejectQuestion,
			setModel,
			setAgent,
			doCycleVariant,
			clearError,
			refreshProviders,
			refreshSessions,
			getQueuedPrompts,
			removeFromQueue,
			reorderQueue,
			updateQueuedPrompt,
			sendQueuedNow,
			setSessionDraft,
			clearSessionDraft,
			openDirectory,
			connectToProject,
			startDraftSession,
			setDraftDirectory,
			setDraftTemporary,
			revertToMessage,
			unrevert,
			forkFromMessage,
			setSessionColor,
			setSessionTags,
			registerWorktree,
			unregisterWorktree,
			touchWorktree,
			clearWorktreeCleanup,
			createWorkspace,
			updateWorkspace,
			removeWorkspace,
			switchWorkspace,
		],
	);

	// Clean up temporary sessions on window unload (app close / refresh)
	useEffect(() => {
		const cleanup = () => {
			for (const id of stateRef.current.temporarySessions) {
				bridge?.deleteSession(id).catch(() => {
					/* best-effort cleanup on unload */
				});
			}
		};
		window.addEventListener("beforeunload", cleanup);
		return () => window.removeEventListener("beforeunload", cleanup);
	}, [bridge]);

	return (
		<ActionsContext.Provider value={actionsCtx}>
			<ConnectionContext.Provider value={connectionCtx}>
				<ModelContext.Provider value={modelCtx}>
					<SessionContext.Provider value={sessionCtx}>
						<MessagesContext.Provider value={messagesCtx}>
							{children}
						</MessagesContext.Provider>
					</SessionContext.Provider>
				</ModelContext.Provider>
			</ConnectionContext.Provider>
		</ActionsContext.Provider>
	);
}

// ---------------------------------------------------------------------------
// Split hooks  (subscribe only to the slice you need)
// ---------------------------------------------------------------------------

/**
 * Session-related state: sessions list, active session, busy state, queue,
 * permissions, questions, draft, unread, meta.
 *
 * Does NOT include messages or childSessions - use useMessages() for those.
 * This split prevents streaming deltas from re-rendering the sidebar,
 * prompt box, and other components that only care about session metadata.
 */
export function useSessionState(): SessionContextValue {
	const ctx = useContext(SessionContext);
	if (!ctx) {
		throw new Error("useSessionState must be used within <OpenCodeProvider>");
	}
	return ctx;
}

/**
 * Messages and child sessions for the active session.
 *
 * Only components that render message content should use this hook.
 * Changes on every streaming delta - that's the whole point of isolating it.
 */
export function useMessages(): MessagesContextValue {
	const ctx = useContext(MessagesContext);
	if (!ctx) {
		throw new Error("useMessages must be used within <OpenCodeProvider>");
	}
	return ctx;
}

/**
 * Model / agent / variant / command state.
 *
 * Components like ModelSelector, AgentSelector, VariantSelector should use
 * this instead of useOpenCode() to avoid re-rendering on session changes.
 */
export function useModelState(): ModelContextValue {
	const ctx = useContext(ModelContext);
	if (!ctx) {
		throw new Error("useModelState must be used within <OpenCodeProvider>");
	}
	return ctx;
}

/**
 * Connection lifecycle state: per-project connections, boot state, errors,
 * worktree parents.
 */
export function useConnectionState(): ConnectionContextValue {
	const ctx = useContext(ConnectionContext);
	if (!ctx) {
		throw new Error(
			"useConnectionState must be used within <OpenCodeProvider>",
		);
	}
	return ctx;
}

/**
 * Stable action functions.  Because every function is wrapped in useCallback,
 * this context value changes infrequently.  Components that only need to
 * *dispatch* actions (not read state) should use this hook.
 */
export function useActions(): ActionsContextValue {
	const ctx = useContext(ActionsContext);
	if (!ctx) {
		throw new Error("useActions must be used within <OpenCodeProvider>");
	}
	return ctx;
}
