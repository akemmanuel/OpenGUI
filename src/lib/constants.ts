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
	WORKSPACES: "opencode:workspaces",
	ACTIVE_WORKSPACE_ID: "opencode:activeWorkspaceId",
	SELECTED_MODEL: "opencode:selectedModel",
	SELECTED_AGENT: "opencode:selectedAgent",
	VARIANT_SELECTIONS: "opencode:variantSelections",
	RECENT_PROJECTS: "opencode:recentProjects",
	OPEN_PROJECTS: "opencode:openProjects",
	UNREAD_SESSIONS: "opencode:unreadSessionIds",
	SESSION_DRAFTS: "opencode:sessionDrafts",
	QUEUED_PROMPTS: "opencode:queuedPrompts",
	NOTIFICATIONS_ENABLED: "opencode:notificationsEnabled",
	SESSION_META: "opencode:sessionMeta",
	WORKTREE_PARENTS: "opencode:worktreeParents",
	RECENT_MODELS: "opencode:recentModels",
	FAVORITE_MODELS: "opencode:favoriteModels",
	MODEL_MAX_AGE_MONTHS: "opencode:modelMaxAgeMonths",
	THEME: "theme",
	RIGHT_SIDEBAR_OPEN: "opencode:rightSidebarOpen",
	DISMISSED_UPDATE_VERSION: "opencode:dismissedUpdateVersion",
	FILE_MANAGER: "opencode:fileManager",
	TERMINAL: "opencode:terminal",
} as const;

// ---------------------------------------------------------------------------
// UI timing (ms)
// ---------------------------------------------------------------------------

/** Debounce delay before syntax-highlighting fires (ms). */
export const HIGHLIGHT_DEBOUNCE_MS = 150;

/** Duration the "Copied!" badge stays visible after a clipboard copy (ms). */
export const COPY_FEEDBACK_MS = 2000;

/** Delay before sending a prompt after a merge operation (ms). */
export const POST_MERGE_DELAY_MS = 300;

/** Artificial delay after toggling an MCP server to let the server settle (ms). */
export const MCP_TOGGLE_DELAY_MS = 300;

/** Artificial delay after updating skills config (ms). */
export const SKILLS_REFRESH_DELAY_MS = 500;

/** Maximum textarea height in px before scrolling. */
export const MAX_TEXTAREA_HEIGHT_PX = 200;

/** Small-window breakpoint for prompt box layout (px). */
export const SMALL_WINDOW_BREAKPOINT_PX = 640;

/** Number of sessions to show per "page" in the sidebar. */
export const SESSION_PAGE_SIZE = 5;

/** Maximum number of recent projects to remember. */
export const MAX_RECENT_PROJECTS = 10;

/** Maximum number of recent models to remember. */
export const MAX_RECENT_MODELS = 8;

/** Default maximum model age in months before it is hidden from the picker. */
export const DEFAULT_MODEL_MAX_AGE_MONTHS = 6;

/** Threshold in px – if the user is within this distance of the bottom we consider them "at bottom". */
export const NEAR_BOTTOM_PX = 80;

/** Character count threshold before a user message is collapsed. */
export const USER_MSG_COLLAPSE_CHARS = 500;

// ---------------------------------------------------------------------------
// Context menu styles (radix-ui ContextMenu)
// ---------------------------------------------------------------------------

/** Base class for `ContextMenu.Item`. */
export const CTX_ITEM_CLASS =
	"flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground";

/** Class for `ContextMenu.SubTrigger` (extends item with open-state highlight). */
export const CTX_SUBTRIGGER_CLASS = `${CTX_ITEM_CLASS} data-[state=open]:bg-accent`;

/** Class for `ContextMenu.Separator`. */
export const CTX_SEPARATOR_CLASS = "-mx-1 my-1 h-px bg-muted";

/** Class for `ContextMenu.Content`. */
export const CTX_CONTENT_CLASS =
	"z-50 min-w-[12rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95";

// ---------------------------------------------------------------------------
// Popular providers
// ---------------------------------------------------------------------------

/** Provider IDs shown in the "Popular" section of provider pickers. */
export const POPULAR_PROVIDER_IDS = [
	"anthropic",
	"openai",
	"google",
	"github-copilot",
	"openrouter",
	"xai",
	"deepseek",
	"groq",
	"mistral",
	"azure",
] as const;
