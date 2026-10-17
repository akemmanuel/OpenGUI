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
  WORKSPACES: key("workspaces"),
  ACTIVE_WORKSPACE_ID: key("activeWorkspaceId"),
  REASONING_EFFORT: key("reasoningEffort"),
  SESSION_DRAFTS: key("sessionDrafts"),
  NOTIFICATIONS_ENABLED: key("notificationsEnabled"),
  SESSION_META: key("sessionMeta"),
  PROJECT_META: key("projectMeta"),
  DEFAULT_CHAT_DIRECTORY: key("defaultChatDirectory"),
  RECENT_MODELS: key("recentModels"),
  MODEL_MAX_AGE_MONTHS: key("modelMaxAgeMonths"),
  NEW_CHAT_MODEL_BEHAVIOR: key("newChatModelBehavior"),
  LANGUAGE: key("language"),
  THEME: "theme",
  CHAT_WIDTH: key("chatWidth"),
  SIDEBAR_WIDTH: key("sidebarWidth"),
  CONTRAST: key("contrast"),
  ACCENT_COLOR: key("accentColor"),
  DISMISSED_UPDATE_VERSION: key("dismissedUpdateVersion"),
  SIDEBAR_PROJECT_COLLAPSED: key("sidebarProjectCollapsed"),
  RESPONDING_SIDEBAR: key("respondingSidebar"),
  FILE_MANAGER: key("fileManager"),
  TERMINAL: key("terminal"),
  SETUP_COMPLETE: key("setupComplete"),
} as const;

// ---------------------------------------------------------------------------
// UI timing (ms)
// ---------------------------------------------------------------------------

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
// Context menu styles (Base UI ContextMenu)
// ---------------------------------------------------------------------------

/** Base class for `ContextMenu.Item`. */
export const CTX_ITEM_CLASS =
  "flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground";

/** Class for `ContextMenu.SubTrigger` (extends item with open-state highlight). */
export const CTX_SUBTRIGGER_CLASS = `${CTX_ITEM_CLASS} data-[state=open]:bg-accent`;

/** Class for `ContextMenu.Separator`. */
export const CTX_SEPARATOR_CLASS = "-mx-1 my-1 h-px bg-muted";
