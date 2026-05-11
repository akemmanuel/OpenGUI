/**
 * Shared constants used across the application.
 *
 * Centralises magic strings (localStorage keys, URLs) and magic numbers
 * so they are defined in exactly one place.
 */

// ---------------------------------------------------------------------------
// Server defaults
// ---------------------------------------------------------------------------

const DEFAULT_SERVER_PORT = 4096;
export const DEFAULT_SERVER_URL = `http://127.0.0.1:${DEFAULT_SERVER_PORT}`;

// ---------------------------------------------------------------------------
// localStorage keys
// ---------------------------------------------------------------------------

export const STORAGE_KEYS = {
  AGENT_BACKEND: "agent:backend",
  SERVER_URL: "opencode:serverUrl",
  USERNAME: "opencode:username",
  WORKSPACES: "opencode:workspaces",
  ACTIVE_WORKSPACE_ID: "opencode:activeWorkspaceId",
  SELECTED_MODEL: "opencode:selectedModel",
  SELECTED_AGENT: "opencode:selectedAgent",
  VARIANT_SELECTIONS: "opencode:variantSelections",
  UNREAD_SESSIONS: "opencode:unreadSessionIds",
  SESSION_DRAFTS: "opencode:sessionDrafts",
  SESSION_DRAFT_IMAGES: "opencode:sessionDraftImages",
  QUEUED_PROMPTS: "opencode:queuedPrompts",
  NOTIFICATIONS_ENABLED: "opencode:notificationsEnabled",
  SESSION_META: "opencode:sessionMeta",
  PROJECT_META: "opencode:projectMeta",
  DEFAULT_CHAT_DIRECTORY: "opencode:defaultChatDirectory",
  WORKTREE_PARENTS: "opencode:worktreeParents",
  RECENT_MODELS: "opencode:recentModels",
  FAVORITE_MODELS: "opencode:favoriteModels",
  MODEL_MAX_AGE_MONTHS: "opencode:modelMaxAgeMonths",
  LANGUAGE: "opengui:language",
  THEME: "theme",
  CONTRAST: "opengui:contrast",
  ACCENT_COLOR: "opengui:accentColor",
  CODE_FONT_SIZE: "opengui:codeFontSize",
  DISMISSED_UPDATE_VERSION: "opencode:dismissedUpdateVersion",
  SIDEBAR_PROJECT_COLLAPSED: "opencode:sidebarProjectCollapsed",
  FILE_MANAGER: "opencode:fileManager",
  TERMINAL: "opencode:terminal",
  SETUP_COMPLETE: "opengui:setupComplete",
} as const;

// ---------------------------------------------------------------------------
// UI timing (ms)
// ---------------------------------------------------------------------------

/** Delay before sending a prompt after a merge operation (ms). */
export const POST_MERGE_DELAY_MS = 300;

/** Artificial delay after toggling an MCP server to let the server settle (ms). */
export const MCP_TOGGLE_DELAY_MS = 300;

/** Maximum textarea height in px before scrolling. */
export const MAX_TEXTAREA_HEIGHT_PX = 200;

/** Number of sessions to show per "page" in the sidebar. */
export const SESSION_PAGE_SIZE = 5;

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
