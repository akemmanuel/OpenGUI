/**
 * The Claude Code provider's rules, free of the Agent SDK so they can be tested alone.
 * `runtime.ts` drives Claude Code with them.
 *
 * OpenGUI's transcript is the source of truth. Each request carries the whole transcript,
 * as for any other pi provider. The runtime keeps one Claude Code process per OpenGUI
 * Session and compares the transcript with what that process has already seen:
 *
 * - continue: the process has seen a prefix; the rest are results for the tool calls it
 *   is holding and/or new user messages.
 * - retry: nothing new; the previous request's answer is returned again.
 * - fresh: anything else (another model wrote history, an edit, a compaction, a lost
 *   process). A new process starts and the transcript arrives as one message.
 *
 * Adapted from the crocov3 Claude bridge (`scripts/claude-bridge/bridgeproto.py`).
 */
import { createHash } from "node:crypto";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  Tool,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";

/** In-process MCP server name. Claude sees OpenGUI's tools as `mcp__og__<tool>`. */
export const MCP_SERVER = "og";
export const MCP_PREFIX = `mcp__${MCP_SERVER}__`;
/** Claude Code's API rejects tool names longer than this, prefix included. */
const MAX_TOOL_NAME_LENGTH = 64;
/** Per-entry cap in a checkpoint transcript; OpenGUI already bounds tool results. */
const TEXT_CAP = 200_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const CHECKPOINT_OPEN =
  "<conversation-checkpoint>\n" +
  "This is the conversation so far, from before this session started. Treat it as earlier " +
  "conversation, not as new requests. Your earlier tool calls are shown with their arguments " +
  "and results; call tools again only when you need something new. Continue with what follows " +
  "the checkpoint.\n";
export const CHECKPOINT_CLOSE = "</conversation-checkpoint>";
export const CONTINUE_NOTE = "[Application note: continue from where the conversation above ends.]";

type TranscriptEntry = UserMessage | AssistantMessage | ToolResultMessage;

/** Anthropic content blocks, as Claude Code accepts them in a streamed user message. */
export type ClaudeUserBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

/** MCP tool-result content. */
export type McpBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined && item !== null)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digest(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex").slice(0, 32);
}

/** The conversation without system messages; the prompt and tools are the session's epoch. */
export function transcriptEntries(messages: readonly Message[]): TranscriptEntry[] {
  return messages.filter((message): message is TranscriptEntry => message.role !== "system");
}

function contentBlocks(content: UserMessage["content"] | ToolResultMessage["content"]) {
  return typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
}

function assistantText(message: AssistantMessage) {
  return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

/**
 * Identity of a transcript entry, stable across the way OpenGUI stores and rebuilds it.
 * OpenGUI keeps an assistant turn as its concatenated text plus its tool calls, and drops
 * thinking, so an assistant entry is known by its tool-call ids, or else by its text.
 */
export function fingerprint(entry: TranscriptEntry): string {
  if (entry.role === "assistant") {
    const calls = entry.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
    if (calls.length > 0) return `assistant:calls:${calls.join(",")}`;
    return `assistant:${digest(assistantText(entry))}`;
  }
  if (entry.role === "toolResult") {
    return `tool:${entry.toolCallId}:${digest({ content: entry.content, isError: entry.isError })}`;
  }
  return `user:${digest(contentBlocks(entry.content))}`;
}

function cap(text: string, limit = TEXT_CAP) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[${text.length - limit} more characters left out here.]`;
}

function imageBlock(image: ImageContent): ClaudeUserBlock {
  if (IMAGE_TYPES.has(image.mimeType) && image.data) {
    return {
      type: "image",
      source: { type: "base64", media_type: image.mimeType, data: image.data },
    };
  }
  return { type: "text", text: `[image of type ${image.mimeType} not shown]` };
}

/** pi user content as Anthropic blocks for a user turn. */
export function userBlocks(content: UserMessage["content"]): ClaudeUserBlock[] {
  return contentBlocks(content).flatMap((block): ClaudeUserBlock[] => {
    if (block.type === "text") return block.text ? [{ type: "text", text: block.text }] : [];
    return [imageBlock(block)];
  });
}

/** pi tool-result content as MCP tool-result blocks. */
export function mcpBlocks(content: ToolResultMessage["content"]): McpBlock[] {
  const blocks = content.flatMap((block): McpBlock[] => {
    if (block.type === "text") return [{ type: "text", text: block.text || " " }];
    if (IMAGE_TYPES.has(block.mimeType) && block.data) {
      return [{ type: "image", data: block.data, mimeType: block.mimeType }];
    }
    return [{ type: "text", text: `[image of type ${block.mimeType} not shown]` }];
  });
  return blocks.length > 0 ? blocks : [{ type: "text", text: "(no output)" }];
}

/** Builds transcript text with images kept as real image blocks in order. */
class TranscriptWriter {
  readonly blocks: ClaudeUserBlock[] = [];
  #text = "";

  text(value: string) {
    this.#text += value;
  }

  image(image: ImageContent) {
    this.#flush();
    this.blocks.push(imageBlock(image));
  }

  #flush() {
    if (this.#text) this.blocks.push({ type: "text", text: this.#text });
    this.#text = "";
  }

  finish() {
    this.#flush();
    return this.blocks;
  }
}

function writeContent(
  writer: TranscriptWriter,
  content: readonly (TextContent | ImageContent)[] | string,
) {
  for (const block of contentBlocks(content as UserMessage["content"])) {
    if (block.type === "text") writer.text(cap(block.text));
    else writer.image(block);
  }
}

function writeEntry(writer: TranscriptWriter, entry: TranscriptEntry) {
  if (entry.role === "user") {
    writer.text("[user]\n");
    writeContent(writer, entry.content);
  } else if (entry.role === "toolResult") {
    const label = entry.isError ? "error result" : "result";
    writer.text(`[${label} of ${entry.toolName} ${entry.toolCallId}]\n`);
    writeContent(writer, entry.content);
  } else {
    const lines: string[] = [];
    const text = assistantText(entry);
    if (text.trim()) lines.push(`[you]\n${cap(text)}`);
    for (const block of entry.content) {
      if (block.type !== "toolCall") continue;
      lines.push(`[you called ${block.name} ${block.id}]\n${cap(JSON.stringify(block.arguments))}`);
    }
    writer.text(lines.join("\n"));
  }
  writer.text("\n\n");
}

/**
 * The first message of a fresh session: history the session has not seen as a transcript,
 * then the trailing user messages as themselves.
 */
export function checkpointContent(entries: readonly TranscriptEntry[]): ClaudeUserBlock[] {
  let end = 0;
  entries.forEach((entry, index) => {
    if (entry.role !== "user") end = index + 1;
  });
  const history = entries.slice(0, end);
  const trailing = entries.slice(end);
  const writer = new TranscriptWriter();
  if (history.length > 0) {
    writer.text(`${CHECKPOINT_OPEN}\n`);
    for (const entry of history) writeEntry(writer, entry);
    writer.text(CHECKPOINT_CLOSE);
  }
  const blocks = writer.finish();
  for (const entry of trailing) blocks.push(...userBlocks((entry as UserMessage).content));
  if (trailing.length === 0) blocks.push({ type: "text", text: CONTINUE_NOTE });
  return blocks;
}

export type Plan =
  | { kind: "fresh" }
  | { kind: "retry" }
  | { kind: "continue"; results: ToolResultMessage[]; users: UserMessage[] };

/**
 * What to do with a request.
 *
 * @param records fingerprints of the entries the session has seen, in order, ending with
 *   its last response's fingerprint when it has one.
 * @param response fingerprint of the last response, or null.
 * @param held tool-call ids the session is waiting on (from the last response).
 */
export function plan(
  records: readonly string[],
  response: string | null,
  held: readonly string[],
  entries: readonly TranscriptEntry[],
): Plan {
  const fingerprints = entries.map(fingerprint);
  const seen = records.length;
  if (seen === 0) return { kind: "fresh" };
  const same = (length: number) =>
    fingerprints.length >= length &&
    records.slice(0, length).every((record, index) => record === fingerprints[index]);
  let fresh: TranscriptEntry[];
  if (same(seen)) {
    fresh = entries.slice(seen);
  } else if (response !== null && records.at(-1) === response && same(seen - 1)) {
    // The last response is not in the transcript: a retry of the same request.
    fresh = entries.slice(seen - 1);
    if (fresh.length === 0) return { kind: "retry" };
    // OpenGUI dropped the response and moved on; Claude Code cannot forget it.
    return { kind: "fresh" };
  } else {
    return { kind: "fresh" };
  }
  if (fresh.length === 0) return { kind: "retry" };
  const results: ToolResultMessage[] = [];
  const rest = [...fresh];
  if (held.length > 0) {
    while (rest[0]?.role === "toolResult" && held.includes(rest[0].toolCallId)) {
      results.push(rest.shift() as ToolResultMessage);
    }
    const answered = new Set(results.map((result) => result.toolCallId));
    if (answered.size !== held.length || results.length !== held.length) return { kind: "fresh" };
  }
  if (rest.some((entry) => entry.role !== "user")) return { kind: "fresh" };
  if (held.length === 0 && rest.length === 0) return { kind: "fresh" };
  return { kind: "continue", results, users: rest as UserMessage[] };
}

export function userContent(users: readonly UserMessage[]): ClaudeUserBlock[] {
  return users.flatMap((user) => userBlocks(user.content));
}

/** OpenGUI tool names as valid, unique MCP tool names, and the way back. */
export function toolNameMap(tools: readonly Tool[]) {
  const toClaude = new Map<string, string>();
  const fromClaude = new Map<string, string>();
  const limit = MAX_TOOL_NAME_LENGTH - MCP_PREFIX.length;
  for (const tool of tools) {
    const base = tool.name.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, limit) || "tool";
    let name = base;
    for (let index = 2; fromClaude.has(name); index += 1) {
      const suffix = `_${index}`;
      name = `${base.slice(0, limit - suffix.length)}${suffix}`;
    }
    toClaude.set(tool.name, name);
    fromClaude.set(name, tool.name);
  }
  return { toClaude, fromClaude };
}

/** A session lives as long as its instructions, tools, model, effort and credential. */
export function epoch(input: {
  systemPrompt: string;
  tools: readonly Tool[];
  model: string;
  effort?: string;
  credential: string;
}) {
  return digest({
    system: input.systemPrompt,
    tools: input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    model: input.model,
    effort: input.effort ?? "default",
    credential: digest(input.credential),
  });
}

/** Anthropic-style usage, merged across one API response's streaming snapshots. */
export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
}

export function mergeUsage(previous: ClaudeUsage, current: ClaudeUsage | null | undefined) {
  const merged: ClaudeUsage = { ...previous };
  for (const [key, value] of Object.entries(current ?? {})) {
    if (value === null || value === undefined) continue;
    (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

export function addUsage(total: UsageTotals, usage: ClaudeUsage) {
  total.input += usage.input_tokens ?? 0;
  total.output += usage.output_tokens ?? 0;
  total.cacheRead += usage.cache_read_input_tokens ?? 0;
  total.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  const longWrite = usage.cache_creation?.ephemeral_1h_input_tokens;
  if (typeof longWrite === "number") total.cacheWrite1h = (total.cacheWrite1h ?? 0) + longWrite;
  return total;
}

/**
 * A failure in words OpenGUI's `normalizeModelError` classifies, so runs retry or stop as
 * they would for any provider: authentication carries 401, limits say "rate limit" or
 * "usage limit", a full context says "input is too long".
 */
export function errorMessage(text: string) {
  const lower = text.toLowerCase();
  if (
    /overage|usage credits|extra usage|billing|credit balance|usage limit|out of usage/u.test(lower)
  ) {
    return `Claude usage limit reached: ${text}`;
  }
  // Before status codes: a context error's token counts can contain "429".
  if (
    lower.includes("prompt is too long") ||
    (lower.includes("context") && lower.includes("too long"))
  ) {
    return `Claude Code context window exceeded, input is too long: ${text}`;
  }
  if (/rate_limit|rate limit|\b429\b/u.test(lower)) return `Claude rate limit (429): ${text}`;
  if (
    /authentication|not logged in|log in|oauth|invalid api key|invalid_grant|unauthorized|\b401\b/u.test(
      lower,
    )
  ) {
    return `Claude Code authentication failed (401): ${text}`;
  }
  if (/overloaded|server_error|api_error|\b(?:529|503|502|500)\b/u.test(lower)) {
    return `Claude is overloaded or unavailable (503): ${text}`;
  }
  return `Claude Code request failed: ${text}`;
}

/** Claude Code's assistant-message error codes, in the same words. */
export function assistantErrorMessage(code: string) {
  switch (code) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
      return errorMessage(`authentication failed (${code})`);
    case "billing_error":
      return errorMessage("billing: usage limit reached");
    case "rate_limit":
      return errorMessage("rate limit");
    case "overloaded":
    case "server_error":
      return errorMessage(`overloaded (${code})`);
    case "max_output_tokens":
      return errorMessage("the response exceeded the maximum output tokens");
    default:
      return errorMessage(code);
  }
}
