/**
 * Shared constants used across the application.
 *
 * Centralises magic strings (frontend persistence keys, URLs) and magic numbers
 * so they are defined in exactly one place.
 */

// ---------------------------------------------------------------------------
// Server defaults
// ---------------------------------------------------------------------------

const DEFAULT_SERVER_PORT = 4096;
export const DEFAULT_SERVER_URL = `http://127.0.0.1:${DEFAULT_SERVER_PORT}`;

// ---------------------------------------------------------------------------
// Frontend persistence keys
// ---------------------------------------------------------------------------

const key = (name: string) => `opengui:${name}`;

export const STORAGE_KEYS = {
  HARNESS: key("selectedHarness"),
  SERVER_URL: key("serverUrl"),
  USERNAME: key("username"),
  WORKSPACES: key("workspaces"),
  ACTIVE_WORKSPACE_ID: key("activeWorkspaceId"),
  SELECTED_MODEL: key("selectedModel"),
  SELECTED_AGENT: key("selectedAgent"),
  VARIANT_SELECTIONS: key("variantSelections"),
  WORKSPACE_VARIANT_SELECTIONS: key("workspaceVariantSelections"),
  UNREAD_SESSIONS: key("unreadSessionIds"),
  SESSION_DRAFTS: key("sessionDrafts"),
  NOTIFICATIONS_ENABLED: key("notificationsEnabled"),
  SESSION_META: key("sessionMeta"),
  PROJECT_META: key("projectMeta"),
  DEFAULT_CHAT_DIRECTORY: key("defaultChatDirectory"),
  WORKTREE_PARENTS: key("worktreeParents"),
  RECENT_MODELS: key("recentModels"),
  FAVORITE_MODELS: key("favoriteModels"),
  MODEL_MAX_AGE_MONTHS: key("modelMaxAgeMonths"),
  NEW_CHAT_MODEL_BEHAVIOR: key("newChatModelBehavior"),
  LANGUAGE: key("language"),
  THEME: "theme",
  CONTRAST: key("contrast"),
  ACCENT_COLOR: key("accentColor"),
  CODE_FONT_SIZE: key("codeFontSize"),
  DISMISSED_UPDATE_VERSION: key("dismissedUpdateVersion"),
  SIDEBAR_PROJECT_COLLAPSED: key("sidebarProjectCollapsed"),
  FILE_MANAGER: key("fileManager"),
  TERMINAL: key("terminal"),
  SETUP_COMPLETE: key("setupComplete"),
} as const;

const legacyKey = (name: string) => `opencode:${name}`;

export const LEGACY_STORAGE_KEYS: Partial<
  Record<(typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS], string>
> = {
  [STORAGE_KEYS.HARNESS]: "harness:selected",
  [STORAGE_KEYS.SERVER_URL]: legacyKey("serverUrl"),
  [STORAGE_KEYS.USERNAME]: legacyKey("username"),
  [STORAGE_KEYS.WORKSPACES]: legacyKey("workspaces"),
  [STORAGE_KEYS.ACTIVE_WORKSPACE_ID]: legacyKey("activeWorkspaceId"),
  [STORAGE_KEYS.SELECTED_MODEL]: legacyKey("selectedModel"),
  [STORAGE_KEYS.SELECTED_AGENT]: legacyKey("selectedAgent"),
  [STORAGE_KEYS.VARIANT_SELECTIONS]: legacyKey("variantSelections"),
  [STORAGE_KEYS.WORKSPACE_VARIANT_SELECTIONS]: legacyKey("workspaceVariantSelections"),
  [STORAGE_KEYS.UNREAD_SESSIONS]: legacyKey("unreadSessionIds"),
  [STORAGE_KEYS.SESSION_DRAFTS]: legacyKey("sessionDrafts"),
  [STORAGE_KEYS.NOTIFICATIONS_ENABLED]: legacyKey("notificationsEnabled"),
  [STORAGE_KEYS.SESSION_META]: legacyKey("sessionMeta"),
  [STORAGE_KEYS.PROJECT_META]: legacyKey("projectMeta"),
  [STORAGE_KEYS.DEFAULT_CHAT_DIRECTORY]: legacyKey("defaultChatDirectory"),
  [STORAGE_KEYS.WORKTREE_PARENTS]: legacyKey("worktreeParents"),
  [STORAGE_KEYS.RECENT_MODELS]: legacyKey("recentModels"),
  [STORAGE_KEYS.FAVORITE_MODELS]: legacyKey("favoriteModels"),
  [STORAGE_KEYS.MODEL_MAX_AGE_MONTHS]: legacyKey("modelMaxAgeMonths"),
  [STORAGE_KEYS.NEW_CHAT_MODEL_BEHAVIOR]: legacyKey("newChatModelBehavior"),
  [STORAGE_KEYS.LANGUAGE]: legacyKey("language"),
  [STORAGE_KEYS.CONTRAST]: legacyKey("contrast"),
  [STORAGE_KEYS.ACCENT_COLOR]: legacyKey("accentColor"),
  [STORAGE_KEYS.CODE_FONT_SIZE]: legacyKey("codeFontSize"),
  [STORAGE_KEYS.DISMISSED_UPDATE_VERSION]: legacyKey("dismissedUpdateVersion"),
  [STORAGE_KEYS.SIDEBAR_PROJECT_COLLAPSED]: legacyKey("sidebarProjectCollapsed"),
  [STORAGE_KEYS.FILE_MANAGER]: legacyKey("fileManager"),
  [STORAGE_KEYS.TERMINAL]: legacyKey("terminal"),
  [STORAGE_KEYS.SETUP_COMPLETE]: legacyKey("setupComplete"),
};

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

/** Threshold in px – scrollTop at or below this counts as "at top" for pagination and snapshots. */
export const NEAR_TOP_PX = 1;

/** Character count threshold before a user message is collapsed. */
export const USER_MSG_COLLAPSE_CHARS = 500;

// ---------------------------------------------------------------------------
// Context menu styles (Base UI ContextMenu)
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
