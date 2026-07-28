import type { ModelRequest, ModelToolDefinition, ModelToolName } from "../models/transport.ts";

export interface ToolDefinition extends ModelToolDefinition {
  name: ModelToolName;
  description: string;
  parameters: {
    type: "object";
    properties: Record<
      string,
      {
        type: string;
        description?: string;
        default?: number;
        exclusiveMinimum?: number;
        maximum?: number;
      }
    >;
    required: string[];
  };
}

/** Single source of truth for model-facing tool schemas (all transports). */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "read",
    description:
      "Read a text file or image (jpg, png, gif, webp, bmp) from an absolute or Project-relative path. Images are injected into the model as attachments.",
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
      "Run one non-interactive command in the Project directory; process state does not carry across calls. Commands time out after 30 seconds by default.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: {
          type: "number",
          description: "Timeout in seconds (default 30, maximum 5000).",
          default: 30,
          exclusiveMinimum: 0,
          maximum: 5_000,
        },
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

export function modelToolDefinitionsFor(
  request: Pick<ModelRequest, "tools" | "toolDefinitions">,
): ModelToolDefinition[] {
  return request.toolDefinitions
    ? request.toolDefinitions.map((definition) => structuredClone(definition))
    : toolDefinitionsFor(request.tools);
}
