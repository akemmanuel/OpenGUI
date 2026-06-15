import type { TodoItem } from "@/lib/todos";
import type { TFunction } from "i18next";
import { extractTodos } from "@/lib/todos";
import { looksLikeTerminalOutput } from "@/lib/utils";
import type { ToolCallState, ToolCallTranscriptPart } from "@/protocol/session-transcript";
import type { ApplyPatchFileDiff } from "./applyPatch";
import {
  extractEditFiles,
  getApplyPatchContextLabel,
  summarizeApplyPatchFiles,
} from "./applyPatch";
import { extractImageAttachments, type ImageAttachmentInfo } from "./imageAttachments";
import { extractTaskInfo, getTaskDurationLabel, type TaskInfo } from "./taskTool";
import { getToolInput, isRecord, prettifyToolName, stringField } from "./toolCallUtils";

export type ToolCallStatus = "running" | "success" | "error";
export type ToolCallKind =
  | "read"
  | "bash"
  | "edit"
  | "write"
  | "grep"
  | "glob"
  | "todo"
  | "task"
  | "browser"
  | "fetch"
  | "unknown";

export type ToolOutputBlock =
  | { type: "text"; text: string; format: "plain" | "terminal" }
  | { type: "images"; images: ImageAttachmentInfo[] }
  | { type: "diff"; files: ApplyPatchFileDiff[] }
  | { type: "task"; taskInfo: TaskInfo }
  | { type: "todos"; todos: TodoItem[] };

export interface ToolCallViewModel {
  id: string;
  rawName: string;
  kind: ToolCallKind;
  status: ToolCallStatus;
  label: string;
  matchCount: number | null;
  diffSummary: { added: number; removed: number } | null;
  durationLabel: string | null;
  output: ToolOutputBlock[];
  rawOutput: string | null;
  expandable: boolean;
}

const KNOWN_TOOLS: Record<string, ToolCallKind> = {
  read: "read",
  mcp_read: "read",
  bash: "bash",
  shell: "bash",
  execute_command: "bash",
  terminal: "bash",
  run_command: "bash",
  edit: "edit",
  patch: "edit",
  apply_patch: "edit",
  str_replace: "edit",
  replace: "edit",
  multi_edit: "edit",
  write: "write",
  create_file: "write",
  overwrite: "write",
  grep: "grep",
  mcp_grep: "grep",
  search: "grep",
  rg: "grep",
  ripgrep: "grep",
  glob: "glob",
  mcp_glob: "glob",
  find: "glob",
  list: "glob",
  ls: "glob",
  todowrite: "todo",
  todo_write: "todo",
  update_plan: "todo",
  plan: "todo",
  task: "task",
  subagent: "task",
  delegate: "task",
  browser: "browser",
  screenshot: "browser",
  click: "browser",
  navigate: "browser",
  open_url: "browser",
  fetch: "fetch",
  http: "fetch",
  web_fetch: "fetch",
  curl: "fetch",
};

function normalizeKind(name: string): ToolCallKind {
  return KNOWN_TOOLS[name.toLowerCase()] ?? "unknown";
}

function normalizeStatus(status: ToolCallState["status"]): ToolCallStatus {
  if (status === "error") return "error";
  if (status === "completed") return "success";
  return "running";
}

function rawOutput(state: ToolCallState): string | null {
  return "output" in state && typeof state.output === "string" ? state.output : null;
}

function metadataOutput(state: ToolCallState): string | null {
  if (!("metadata" in state) || !isRecord(state.metadata)) return null;
  return typeof state.metadata.output === "string" ? state.metadata.output : null;
}

function errorOutput(state: ToolCallState): string | null {
  return "error" in state && typeof state.error === "string" ? state.error : null;
}

function meaningfulText(value: string | null | undefined): string | null {
  if (!value) return null;
  const lines = value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim() && !/^>+$/.test(line.trim()));
  const text = lines.join("\n").trim();
  return text ? text : null;
}

function labelFor(
  kind: ToolCallKind,
  part: ToolCallTranscriptPart,
  running: boolean,
  input: Record<string, unknown> | null,
  editFiles: ApplyPatchFileDiff[],
  taskInfo: TaskInfo | null,
  t?: TFunction,
): string {
  const path = stringField(input, "filePath") ?? stringField(input, "path");
  const command = stringField(input, "command");
  const pattern = stringField(input, "pattern");
  switch (kind) {
    case "bash":
      return command
        ? `${t?.(running ? "toolLabels.bash.running" : "toolLabels.bash.done") ?? (running ? "Running" : "Ran")} ${command}`
        : (t?.(running ? "toolLabels.bash.running" : "toolLabels.bash.done") ??
            (running ? "Running" : "Ran"));
    case "read":
      return path
        ? `${t?.(running ? "toolLabels.read.running" : "toolLabels.read.done") ?? (running ? "Reading" : "Read")} ${path}`
        : (t?.(running ? "toolLabels.read.running" : "toolLabels.read.done") ??
            (running ? "Reading" : "Read"));
    case "write":
      return path
        ? `${t?.(running ? "toolLabels.write.running" : "toolLabels.write.done") ?? (running ? "Writing" : "Wrote")} ${path}`
        : (t?.(running ? "toolLabels.write.running" : "toolLabels.write.done") ??
            (running ? "Writing" : "Wrote"));
    case "edit": {
      const target = getApplyPatchContextLabel(editFiles, t) ?? path;
      const verb = running
        ? (t?.("toolLabels.edit.running") ?? "Editing")
        : part.tool.toLowerCase() === "apply_patch"
          ? (t?.("toolLabels.patch.patched") ?? "Patched")
          : (t?.("toolLabels.edit.done") ?? "Edited");
      return target ? `${verb} ${target}` : verb;
    }
    case "grep":
      return pattern
        ? `${t?.(running ? "toolLabels.grep.running" : "toolLabels.grep.done") ?? (running ? "Searching" : "Searched")} ${pattern}`
        : (t?.(running ? "toolLabels.grep.running" : "toolLabels.grep.done") ??
            (running ? "Searching" : "Searched"));
    case "glob":
      return pattern
        ? `${t?.(running ? "toolLabels.glob.running" : "toolLabels.glob.done") ?? (running ? "Globbing" : "Globbed")} ${pattern}`
        : (t?.(running ? "toolLabels.glob.running" : "toolLabels.glob.done") ??
            (running ? "Globbing" : "Globbed"));
    case "todo": {
      const count = Array.isArray(input?.todos) ? input.todos.length : 0;
      return running
        ? (t?.("toolLabels.todo.running") ?? "Writing todos")
        : (t?.(count === 1 ? "toolLabels.todo.doneOne" : "toolLabels.todo.doneOther", { count }) ??
            `Wrote ${count} todos`);
    }
    case "task": {
      const subagent = stringField(input, "subagent_type") ?? stringField(input, "subagentType");
      return subagent
        ? prettifyToolName(subagent)
        : taskInfo?.description ||
            (t?.(running ? "toolLabels.task.running" : "toolLabels.task.done") ??
              (running ? "Running" : "Ran"));
    }
    case "browser":
    case "fetch":
    case "unknown":
      return prettifyToolName(part.tool);
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function getToolCallViewModel(
  part: ToolCallTranscriptPart,
  serverUrl?: string | null,
  t?: TFunction,
): ToolCallViewModel {
  const state = part.state;
  const status = normalizeStatus(state.status);
  const running = status === "running";
  const input = getToolInput(state);
  const kind = normalizeKind(part.tool);
  const text = rawOutput(state);
  const error = errorOutput(state);
  const bashText =
    kind === "bash"
      ? running
        ? (metadataOutput(state) ?? text)
        : (text ?? metadataOutput(state) ?? error)
      : null;
  const editFiles = kind === "edit" ? extractEditFiles(state) : [];
  const taskInfo = kind === "task" ? extractTaskInfo(state) : null;
  const todos = kind === "todo" ? extractTodos(state) : null;
  const images = extractImageAttachments(state, serverUrl);
  const output: ToolOutputBlock[] = [];
  const rawContent = meaningfulText(
    kind === "bash" ? bashText : status === "error" ? (error ?? text) : text,
  );

  if (editFiles.length > 0) output.push({ type: "diff", files: editFiles });
  else if (taskInfo) output.push({ type: "task", taskInfo });
  if (todos?.length) output.push({ type: "todos", todos });
  if (images.length) output.push({ type: "images", images });

  const hasFormattedOutput = output.length > 0;
  if (!hasFormattedOutput && rawContent) {
    output.push({
      type: "text",
      text: rawContent,
      format: kind === "bash" || looksLikeTerminalOutput(rawContent) ? "terminal" : "plain",
    });
  }

  const grepText = meaningfulText(text);
  const match = kind === "grep" ? grepText?.match(/^Found (\d+) match/) : null;
  const matchCount = match ? Number.parseInt(match[1] ?? "", 10) : null;

  return {
    id: part.id,
    rawName: part.tool,
    kind,
    status,
    label: labelFor(kind, part, running, input, editFiles, taskInfo, t),
    matchCount: Number.isFinite(matchCount) ? matchCount : null,
    diffSummary: summarizeApplyPatchFiles(editFiles),
    durationLabel: kind === "task" ? getTaskDurationLabel(state) : null,
    output,
    rawOutput: hasFormattedOutput ? rawContent : null,
    expandable: status !== "error" && output.length > 0,
  };
}
