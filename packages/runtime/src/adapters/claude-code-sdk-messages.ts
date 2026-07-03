/**
 * Narrow Claude Agent SDK stream / history message shapes.
 */
import { isRecord } from "./pi-bridge-rpc.ts";

export type ClaudeTextContentBlock = {
  type: "text";
  text?: string;
};

export type ClaudeThinkingContentBlock = {
  type: "thinking";
  thinking?: string;
  signature?: string;
};

export type ClaudeToolUseContentBlock = {
  type: "tool_use";
  id: string;
  name?: string;
  input?: Record<string, unknown>;
};

export type ClaudeToolResultContentBlock = {
  type: "tool_result";
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

export type ClaudeImageContentBlock = {
  type: "image";
  source?: unknown;
};

export type ClaudeContentBlock =
  | ClaudeTextContentBlock
  | ClaudeThinkingContentBlock
  | ClaudeToolUseContentBlock
  | ClaudeToolResultContentBlock
  | ClaudeImageContentBlock
  | { type: string; [key: string]: unknown };

export type ClaudeSdkMessageBase = {
  type: string;
  subtype?: string;
  message?: { content?: unknown; id?: string; model?: string };
  event?: Record<string, unknown>;
  error?: unknown;
  [key: string]: unknown;
};

export function isToolUseBlock(block: unknown): block is ClaudeToolUseContentBlock {
  return (
    isRecord(block) &&
    block.type === "tool_use" &&
    typeof block.id === "string" &&
    block.id.length > 0
  );
}

export function isToolResultBlock(block: unknown): block is ClaudeToolResultContentBlock {
  return isRecord(block) && block.type === "tool_result";
}

export function parseClaudeSdkMessage(value: unknown): ClaudeSdkMessageBase | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  return value as ClaudeSdkMessageBase;
}
