import type { SelectedModel } from "@opengui/protocol";
import { STORAGE_KEYS } from "@/lib/constants";
import { persistJsonRecord, persistJsonWhen, readJsonOr } from "./json";

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
  pinnedAt?: string;
  selectedModel?: SelectedModel | null;
  selectedAgent?: string | null;
  selectedVariant?: string | null;
  sidebarSection?: "chats" | "projects";
  displayProjectDir?: string | null;
  sidebarMovedAt?: number | null;
  movedToSessionId?: string;
}

export type SessionMetaMap = Record<string, SessionMeta>;

export function getSessionMetaMap(): SessionMetaMap {
  return readJsonOr(STORAGE_KEYS.SESSION_META, {});
}

export function persistSessionMetaMap(meta: SessionMetaMap): void {
  persistJsonRecord(STORAGE_KEYS.SESSION_META, meta, (value) =>
    Boolean(
      value.color ||
      value.tags?.length ||
      value.pinnedAt?.length ||
      Object.hasOwn(value, "selectedModel") ||
      Object.hasOwn(value, "selectedAgent") ||
      Object.hasOwn(value, "selectedVariant") ||
      Object.hasOwn(value, "sidebarSection") ||
      Object.hasOwn(value, "displayProjectDir") ||
      Object.hasOwn(value, "sidebarMovedAt") ||
      Object.hasOwn(value, "movedToSessionId"),
    ),
  );
}

export function getUnreadSessionIds(): Set<string> {
  return new Set(readJsonOr<string[]>(STORAGE_KEYS.UNREAD_SESSIONS, []));
}

export function persistUnreadSessionIds(ids: Set<string>): void {
  persistJsonWhen(STORAGE_KEYS.UNREAD_SESSIONS, [...ids], ids.size > 0);
}
