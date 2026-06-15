import type { TFunction } from "i18next";
import { parseUnifiedDiff, type DiffLine, type DiffResult } from "@/lib/diff";
import type { ToolCallState } from "@/protocol/session-transcript";
import { getToolInput, isRecord, stringField, toFiniteNumber } from "./toolCallUtils";

type ApplyPatchChangeType = "add" | "delete" | "move" | "update";

export interface ApplyPatchFileDiff {
  id: string;
  type: ApplyPatchChangeType;
  path: string;
  previousPath: string | null;
  added: number;
  removed: number;
  lines: DiffLine[];
}

function parseDiffText(value: unknown): DiffResult | null {
  return typeof value === "string" ? parseUnifiedDiff(value) : null;
}

function computeApplyPatchDiff(file: Record<string, unknown>): DiffResult | null {
  return parseDiffText(file.diff);
}

function extractApplyPatchFiles(state: ToolCallState): ApplyPatchFileDiff[] {
  if (!("metadata" in state) || !isRecord(state.metadata)) return [];
  const rawFiles = state.metadata.files;
  if (!Array.isArray(rawFiles)) return [];

  return rawFiles
    .map((entry, index) => {
      if (!isRecord(entry)) return null;
      const diff = computeApplyPatchDiff(entry);
      const typeValue = typeof entry.type === "string" ? entry.type.toLowerCase() : "update";
      const type: ApplyPatchChangeType =
        typeValue === "add" || typeValue === "delete" || typeValue === "move"
          ? typeValue
          : "update";
      const pathValue =
        typeof entry.relativePath === "string"
          ? entry.relativePath
          : typeof entry.movePath === "string"
            ? entry.movePath
            : typeof entry.filePath === "string"
              ? entry.filePath
              : `patch-${index + 1}`;
      const previousPath = typeof entry.filePath === "string" ? entry.filePath : null;
      const added = toFiniteNumber(entry.additions) ?? diff?.added ?? 0;
      const removed = toFiniteNumber(entry.deletions) ?? diff?.removed ?? 0;

      return {
        id: `${pathValue}-${index}`,
        type,
        path: pathValue,
        previousPath,
        added,
        removed,
        lines: diff?.lines ?? [],
      };
    })
    .filter((file): file is ApplyPatchFileDiff => file !== null);
}

/**
 * Normalized edit-file extraction shared by classic edit tools and patch tools.
 * Prefer rich backend metadata when present, but still create a single file row
 * from input.filePath/path so edit and patch tools use the same UI frame.
 */
export function extractEditFiles(state: ToolCallState): ApplyPatchFileDiff[] {
  const metadataFiles = extractApplyPatchFiles(state);
  if (metadataFiles.length > 0) return metadataFiles;

  const input = getToolInput(state);
  const path = stringField(input, "filePath") ?? stringField(input, "path");
  if (!path) return [];

  const metadataDiff = "metadata" in state && isRecord(state.metadata) ? state.metadata.diff : null;
  const outputDiff = "output" in state ? state.output : null;
  const diff = parseDiffText(metadataDiff) ?? parseDiffText(outputDiff);

  return [
    {
      id: path,
      type: "update",
      path,
      previousPath: null,
      added: diff?.added ?? 0,
      removed: diff?.removed ?? 0,
      lines: diff?.lines ?? [],
    },
  ];
}

export function getApplyPatchActionLabel(file: ApplyPatchFileDiff, t: TFunction): string {
  if (file.type === "add") return t("toolLabels.patch.created");
  if (file.type === "delete") return t("toolLabels.patch.deleted");
  if (file.type === "move") return t("toolLabels.patch.moved");
  return t("toolLabels.patch.patched");
}

export function getApplyPatchContextLabel(
  files: ApplyPatchFileDiff[],
  t?: TFunction,
): string | null {
  if (files.length === 0) return null;
  if (files.length === 1) {
    const file = files[0];
    if (!file) return null;
    return file.type === "move" && file.previousPath && file.previousPath !== file.path
      ? `${file.previousPath} -> ${file.path}`
      : file.path;
  }
  return t ? t("toolLabels.fileCountOther", { count: files.length }) : `${files.length} files`;
}

export function summarizeApplyPatchFiles(files: ApplyPatchFileDiff[]) {
  if (files.length === 0) return null;
  return files.reduce(
    (acc, file) => ({ added: acc.added + file.added, removed: acc.removed + file.removed }),
    { added: 0, removed: 0 },
  );
}
