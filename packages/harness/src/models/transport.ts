export type ModelContextItem =
  | {
      type: "user_message";
      text: string;
      model: { connectionId: string; modelId: string };
      reasoning: string;
    }
  | { type: "assistant_message"; text: string }
  | { type: "tool_call"; toolCallId: string; name: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; name: string; output: unknown };

export type ModelToolName = "read" | "write" | "edit" | "shell";

export interface ModelImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

function isModelImageContent(value: unknown): value is ModelImageContent {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string"
  );
}

/** Normalize durable tool output into provider-facing text and image blocks. */
export const IMAGE_UNSUPPORTED_NOTE =
  "[Current model does not support images. The image was omitted from this request.]";

export function modelToolResultContent(output: unknown): {
  text: string;
  images: ModelImageContent[];
} {
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    const images = Array.isArray(record.attachments)
      ? record.attachments.filter(isModelImageContent)
      : [];
    if (images.length > 0) {
      const { attachments: _attachments, ...metadata } = record;
      return {
        text:
          typeof record.content === "string" ? record.content : JSON.stringify(metadata ?? null),
        images,
      };
    }
  }
  return {
    text: typeof output === "string" ? output : JSON.stringify(output ?? null),
    images: [],
  };
}

export function isPossibleImageInputRejection(status: number) {
  return status === 400 || status === 415 || status === 422;
}

export function modelContextHasImages(context: readonly ModelContextItem[]) {
  return context.some(
    (item) => item.type === "tool_result" && modelToolResultContent(item.output).images.length > 0,
  );
}

/** Preserve the readable tool result while removing content rejected by text-only models. */
export function withoutModelContextImages(
  context: readonly ModelContextItem[],
): ModelContextItem[] {
  return context.map((item) => {
    if (item.type !== "tool_result") return item;
    const result = modelToolResultContent(item.output);
    if (result.images.length === 0) return item;
    const output =
      item.output && typeof item.output === "object"
        ? {
            ...(item.output as Record<string, unknown>),
            content: `${result.text}${result.text ? "\n" : ""}${IMAGE_UNSUPPORTED_NOTE}`,
            attachments: [],
          }
        : `${result.text}${result.text ? "\n" : ""}${IMAGE_UNSUPPORTED_NOTE}`;
    return { ...item, output };
  });
}

export interface ModelRequest {
  projectDirectory: string;
  context: ModelContextItem[];
  /** Full system prompt for this turn (identity, env, skills catalog). */
  systemPrompt: string;
  /** Tools available for this turn. Omitted by legacy callers to mean all tools. */
  tools?: readonly ModelToolName[];
}

export type ModelStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "completed" };

export interface ModelTransport {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
}
