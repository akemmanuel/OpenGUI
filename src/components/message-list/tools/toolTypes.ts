import type { ToolPart } from "@opencode-ai/sdk/v2/client";

export type ToolKind =
  | "read"
  | "bash"
  | "edit"
  | "write"
  | "grep"
  | "glob"
  | "todo"
  | "question"
  | "task"
  | "browser"
  | "fetch"
  | "unknown";

export type ToolVariant =
  | "default"
  | "mcp"
  | "shell"
  | "execute_command"
  | "patch"
  | "apply_patch"
  | "search"
  | "find"
  | "subagent"
  | "browser"
  | "fetch";

export type ToolStatus = ToolPart["state"]["status"];

const TOOL_ALIASES = {
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

  question: "question",
  mcp_question: "question",
  ask_user: "question",
  input: "question",

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
} as const satisfies Record<string, ToolKind>;

export function normalizeToolKind(rawName: string): ToolKind {
  return TOOL_ALIASES[rawName.toLowerCase() as keyof typeof TOOL_ALIASES] ?? "unknown";
}

export function normalizeToolVariant(rawName: string): ToolVariant {
  const lower = rawName.toLowerCase();
  if (lower.startsWith("mcp_")) return "mcp";
  if (lower === "shell") return "shell";
  if (lower === "execute_command") return "execute_command";
  if (lower === "patch") return "patch";
  if (lower === "apply_patch") return "apply_patch";
  if (lower === "search" || lower === "rg" || lower === "ripgrep") return "search";
  if (lower === "find" || lower === "list" || lower === "ls") return "find";
  if (lower === "subagent" || lower === "delegate") return "subagent";
  if (normalizeToolKind(lower) === "browser") return "browser";
  if (normalizeToolKind(lower) === "fetch") return "fetch";
  return "default";
}

export function isToolRunning(status: ToolStatus): boolean {
  return status === "running" || status === "pending";
}

export function getToolInput(state: ToolPart["state"]): Record<string, unknown> | null {
  return "input" in state && isRecord(state.input) ? state.input : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function stringField(record: Record<string, unknown> | null | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

export function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
