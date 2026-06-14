import type { ToolPart } from "@opencode-ai/sdk/v2/client";
import type { TFunction } from "i18next";
import type { TodoItem } from "@/lib/todos";
import { extractTodos } from "@/lib/todos";
import type { ApplyPatchFileDiff } from "./applyPatch";
import {
  extractEditFiles,
  getApplyPatchContextLabel,
  summarizeApplyPatchFiles,
} from "./applyPatch";
import { extractImageAttachments, type ImageAttachmentInfo } from "./imageAttachments";
import { extractTaskInfo, getTaskDurationLabel, type TaskInfo } from "./taskTool";
import {
  getToolInput,
  isRecord,
  isToolRunning,
  normalizeToolKind,
  normalizeToolVariant,
  stringField,
  type ToolKind,
  type ToolVariant,
} from "./toolTypes";

export type ToolBody =
  | { type: "terminal"; content: string }
  | { type: "apply-patch"; files: ApplyPatchFileDiff[] }
  | { type: "task"; taskInfo: TaskInfo }
  | null;

interface NormalizedTool {
  rawName: string;
  kind: ToolKind;
  variant: ToolVariant;
  status: ToolPart["state"]["status"];
  isRunning: boolean;
}

export interface ToolPresentation {
  tool: NormalizedTool;
  title: string;
  context: string | null;
  hasDynamicLabel: boolean;
  grepMatchCount: number | null;
  diffSummary: { added: number; removed: number } | null;
  taskDurationLabel: string | null;
  expandable: boolean;
  body: ToolBody;
  sideContent: {
    todos: TodoItem[] | null;
    images: ImageAttachmentInfo[];
  };
  error: string | null;
  taskInfo: TaskInfo | null;
  bashOutputText: string | null;
}

function getRawOutputText(state: ToolPart["state"]): string | null {
  return "output" in state && typeof state.output === "string" ? state.output : null;
}

function getBashMetadataOutput(state: ToolPart["state"]): string | null {
  if (!("metadata" in state) || !isRecord(state.metadata)) return null;
  return typeof state.metadata.output === "string" ? state.metadata.output : null;
}

function getErrorText(state: ToolPart["state"]): string | null {
  return "error" in state && typeof state.error === "string" ? state.error : null;
}

function getToolTitle(part: ToolPart, kind: ToolKind, isRunning: boolean, t: TFunction): string {
  const input = getToolInput(part.state);
  const title =
    "title" in part.state && typeof part.state.title === "string" ? part.state.title : null;

  switch (kind) {
    case "bash":
      return isRunning ? t("toolLabels.bash.running") : t("toolLabels.bash.done");
    case "read":
      return isRunning ? t("toolLabels.read.running") : t("toolLabels.read.done");
    case "edit":
      return isRunning
        ? t("toolLabels.edit.running")
        : part.tool.toLowerCase() === "apply_patch"
          ? t("toolLabels.patch.patched")
          : t("toolLabels.edit.done");
    case "write":
      return isRunning ? t("toolLabels.write.running") : t("toolLabels.write.done");
    case "grep":
      return isRunning ? t("toolLabels.grep.running") : t("toolLabels.grep.done");
    case "glob":
      return isRunning ? t("toolLabels.glob.running") : t("toolLabels.glob.done");
    case "task": {
      const subagent = input?.subagent_type ?? input?.subagentType;
      return typeof subagent === "string"
        ? subagent.charAt(0).toUpperCase() + subagent.slice(1)
        : isRunning
          ? t("toolLabels.task.running")
          : t("toolLabels.task.done");
    }
    case "todo": {
      const todoCount = Array.isArray(input?.todos) ? input.todos.length : 0;
      return isRunning
        ? t("toolLabels.todo.running")
        : t(todoCount === 1 ? "toolLabels.todo.doneOne" : "toolLabels.todo.doneOther", {
            count: todoCount,
          });
    }
    case "question": {
      const qCount = Array.isArray(input?.questions) ? input.questions.length : 0;
      return isRunning
        ? t("toolLabels.question.running")
        : t(qCount === 1 ? "toolLabels.question.doneOne" : "toolLabels.question.doneOther", {
            count: qCount,
          });
    }
    default:
      return title ?? part.tool;
  }
}

export function getToolPresentation(
  part: ToolPart,
  workspaceServerUrl: string | null | undefined,
  t: TFunction,
): ToolPresentation {
  const state = part.state;
  const kind = normalizeToolKind(part.tool);
  const variant = normalizeToolVariant(part.tool);
  const isRunning = isToolRunning(state.status);
  const input = getToolInput(state);

  const normalized: NormalizedTool = {
    rawName: part.tool,
    kind,
    variant,
    status: state.status,
    isRunning,
  };

  const rawOutputText = getRawOutputText(state);
  const outputText = rawOutputText?.trim() || null;
  const errorText = getErrorText(state);
  const bashMetadataOutput = kind === "bash" ? getBashMetadataOutput(state) : null;
  const bashOutputText =
    kind === "bash"
      ? isRunning
        ? (bashMetadataOutput ?? rawOutputText)
        : (rawOutputText ?? bashMetadataOutput ?? errorText)
      : null;

  const editFiles = kind === "edit" ? extractEditFiles(state) : [];
  const editSummary = summarizeApplyPatchFiles(editFiles);
  const todos = kind === "todo" ? extractTodos(state) : null;
  const taskInfo = kind === "task" ? extractTaskInfo(state) : null;
  const taskDurationLabel = kind === "task" ? getTaskDurationLabel(state) : null;
  const images = extractImageAttachments(state, workspaceServerUrl);

  const command = kind === "bash" ? stringField(input, "command") : null;
  const globPattern = kind === "glob" ? stringField(input, "pattern") : null;
  const grepPattern = kind === "grep" ? stringField(input, "pattern") : null;
  const writeContentText =
    kind === "write" ? (stringField(input, "content") ?? rawOutputText) : null;
  const filePath =
    kind === "read" || kind === "edit" || kind === "write"
      ? (stringField(input, "filePath") ?? stringField(input, "path"))
      : null;
  const taskDescription =
    kind === "task" && taskInfo?.description ? `(${taskInfo.description})` : null;
  const editFilesLabel = kind === "edit" ? getApplyPatchContextLabel(editFiles, t) : null;
  const stateTitle =
    state.status === "completed" &&
    state.title &&
    kind !== "todo" &&
    kind !== "task" &&
    kind !== "question"
      ? state.title
      : null;
  const context =
    filePath ??
    editFilesLabel ??
    command ??
    grepPattern ??
    globPattern ??
    taskDescription ??
    stateTitle ??
    null;

  const grepMatchCount =
    kind === "grep" && outputText
      ? (() => {
          const match = outputText.match(/^Found (\d+) match/);
          return match?.[1] ? Number.parseInt(match[1], 10) : null;
        })()
      : null;

  const hasEditFileView = editFiles.length > 0;
  const genericOutputText =
    kind === "bash" ? bashOutputText : kind === "write" ? writeContentText : rawOutputText;
  const body: ToolBody = hasEditFileView
    ? { type: "apply-patch", files: editFiles }
    : kind === "task" && taskInfo
      ? { type: "task", taskInfo }
      : genericOutputText?.trim()
        ? { type: "terminal", content: genericOutputText }
        : null;

  return {
    tool: normalized,
    title: getToolTitle(part, kind, isRunning, t),
    context,
    hasDynamicLabel: [
      "read",
      "edit",
      "bash",
      "write",
      "grep",
      "glob",
      "task",
      "todo",
      "question",
    ].includes(kind),
    grepMatchCount,
    diffSummary: editSummary,
    taskDurationLabel,
    expandable: body !== null || images.length > 0,
    body,
    sideContent: { todos, images },
    error: state.status === "error" && errorText ? errorText : null,
    taskInfo,
    bashOutputText,
  };
}
