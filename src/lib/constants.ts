/**
 * Shared constants used across the application.
 *
 * Centralises magic strings (localStorage keys, URLs) and magic numbers
 * so they are defined in exactly one place.
 */

// ---------------------------------------------------------------------------
// Server defaults
// ---------------------------------------------------------------------------

export const DEFAULT_SERVER_PORT = 4096;
export const DEFAULT_SERVER_URL = `http://127.0.0.1:${DEFAULT_SERVER_PORT}`;

// ---------------------------------------------------------------------------
// localStorage keys
// ---------------------------------------------------------------------------

export const STORAGE_KEYS = {
	SERVER_URL: "opencode:serverUrl",
	DIRECTORY: "opencode:directory",
	USERNAME: "opencode:username",
	SELECTED_MODEL: "opencode:selectedModel",
	SELECTED_AGENT: "opencode:selectedAgent",
	VARIANT_SELECTIONS: "opencode:variantSelections",
	RECENT_PROJECTS: "opencode:recentProjects",
	OPEN_PROJECTS: "opencode:openProjects",
	UNREAD_SESSIONS: "opencode:unreadSessionIds",
	NOTIFICATIONS_ENABLED: "opencode:notificationsEnabled",
	SESSION_META: "opencode:sessionMeta",
	WORKTREE_PARENTS: "opencode:worktreeParents",
	STT_ENDPOINT: "opencode:sttEndpoint",
	RECENT_MODELS: "opencode:recentModels",
	FAVORITE_MODELS: "opencode:favoriteModels",
	THEME: "theme",
} as const;

// ---------------------------------------------------------------------------
// UI timing (ms)
// ---------------------------------------------------------------------------

/** Debounce delay before syntax-highlighting fires (ms). */
export const HIGHLIGHT_DEBOUNCE_MS = 150;

/** Duration the "Copied!" badge stays visible after a clipboard copy (ms). */
export const COPY_FEEDBACK_MS = 2000;

/** Minimum audio blob size (bytes) to send for STT transcription. */
export const MIN_STT_AUDIO_BYTES = 1000;

/** MediaRecorder chunk interval (ms). */
export const STT_CHUNK_INTERVAL_MS = 100;

/** Delay before sending a prompt after a merge operation (ms). */
export const POST_MERGE_DELAY_MS = 300;

/** Artificial delay after toggling an MCP server to let the server settle (ms). */
export const MCP_TOGGLE_DELAY_MS = 300;

/** Artificial delay after updating skills config (ms). */
export const SKILLS_REFRESH_DELAY_MS = 500;

/** Maximum textarea height in px before scrolling. */
export const MAX_TEXTAREA_HEIGHT_PX = 120;

/** Small-window breakpoint for prompt box layout (px). */
export const SMALL_WINDOW_BREAKPOINT_PX = 640;

/** Number of sessions to show per "page" in the sidebar. */
export const SESSION_PAGE_SIZE = 12;

/** Maximum number of recent projects to remember. */
export const MAX_RECENT_PROJECTS = 10;

/** Maximum number of recent models to remember. */
export const MAX_RECENT_MODELS = 8;

/** Approximately six months in milliseconds (for model staleness). */
export const SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 30.4375 * 6;

/** Threshold in px – if the user is within this distance of the bottom we consider them "at bottom". */
export const NEAR_BOTTOM_PX = 80;

/** Character count threshold before a user message is collapsed. */
export const USER_MSG_COLLAPSE_CHARS = 500;
