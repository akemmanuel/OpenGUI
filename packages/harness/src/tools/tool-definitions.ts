import type { ModelToolName } from "../models/transport.ts";

export interface ToolDefinition {
  name: ModelToolName;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string }>;
    required: string[];
  };
}

/** Single source of truth for model-facing tool schemas (all transports). */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "read",
    description: "Read a text file (absolute or Project-relative path).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "number" },
        endLine: { type: "number" },
      },
      required: ["path"],
    },
  },
  {
    name: "write",
    description: "Create or overwrite a text file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        createParents: { type: "boolean" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit",
    description: "Replace exact text in a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
        replaceAll: { type: "boolean" },
      },
      required: ["path", "oldText", "newText"],
    },
  },
  {
    name: "shell",
    description:
      "Run one non-interactive command in the Project directory; process state does not carry across calls.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["command"],
    },
  },
];

export function toolDefinitionsFor(tools?: readonly ModelToolName[]): ToolDefinition[] {
  if (!tools) return [...TOOL_DEFINITIONS];
  const allowed = new Set<string>(tools);
  return TOOL_DEFINITIONS.filter((tool) => allowed.has(tool.name));
}
