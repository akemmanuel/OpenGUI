import { STORAGE_KEYS } from "@/lib/constants";
import { persistJsonRecord, readJsonOr } from "./json";
export * from "./project-sidebar";

export interface ProjectMeta {
  pinnedAt?: string;
  hidden?: boolean;
}
export type ProjectMetaMap = Record<string, ProjectMeta>;

export function getProjectMetaMap(): ProjectMetaMap {
  return readJsonOr(STORAGE_KEYS.PROJECT_META, {});
}

export function persistProjectMetaMap(meta: ProjectMetaMap): void {
  persistJsonRecord(STORAGE_KEYS.PROJECT_META, meta, (value) =>
    Boolean(value.pinnedAt?.length || value.hidden === true),
  );
}
