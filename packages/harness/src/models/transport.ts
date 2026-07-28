import { createHash } from "node:crypto";

export interface ProviderReplayState {
  /** Opaque provider output items required for stateless multi-turn replay. */
  items?: Array<{
    type: "reasoning" | "thinking" | "text";
    id?: string;
    signature?: string;
    encryptedContent?: string;
  }>;
}

export type ModelContextItem =
  | {
      type: "user_message";
      text: string;
      model: { connectionId: string; modelId: string };
      reasoning: string;
    }
  | { type: "assistant_message"; text: string; replay?: ProviderReplayState }
  | { type: "tool_call"; toolCallId: string; name: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; name: string; output: unknown };

export type ModelToolName = "read" | "write" | "edit" | "shell" | (string & {});

export interface ModelToolDefinition {
  name: string;
  /** Human-readable transcript label; provider adapters ignore it. */
  title?: string;
  description: string;
  parameters: Record<string, unknown>;
}

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
  /** Stable Host and Session identity. Never substitute a credential or request token. */
  identity?: {
    hostId: string;
    sessionId: string;
    runId: string;
    /** Durable principal namespace prevents cache affinity crossing user-owned sessions. */
    principalId: string;
  };
  projectDirectory: string;
  /** Actor whose current authorization must be used for Host-side model resolution. */
  actor?: import("../harness.ts").DurableActor;
  context: ModelContextItem[];
  /** Full system prompt for this turn (identity, env, skills catalog). */
  systemPrompt: string;
  /** Tools available for this turn. Omitted by legacy callers to mean all tools. */
  tools?: readonly ModelToolName[];
  /** Complete provider-facing definitions. New dynamic tools must use this field. */
  toolDefinitions?: readonly ModelToolDefinition[];
  /** Optional only when reading/calling legacy Sessions; new Harness calls always set it. */
  cache?: ModelCachePolicy;
  /** Uniform delivery semantics; adapters must not invent independent defaults. */
  delivery?: {
    timeoutMs: number;
    maxRetries: number;
    maxRetryDelayMs: number;
  };
}

export const DEFAULT_MODEL_DELIVERY = {
  timeoutMs: 10 * 60_000,
  maxRetries: 2,
  maxRetryDelayMs: 60_000,
} as const;

export type ModelProtocol =
  | "openai-chat"
  | "anthropic-messages"
  | "openai-responses"
  | "codex-responses";

export interface ModelCachePolicy {
  mode: "off" | "session";
  retention: "none" | "short" | "long";
  /** Changes whenever any provider-visible prefix or authorization capability changes. */
  generation: string;
  invalidation: {
    prompt: string;
    toolSchema: string;
    permissions: string;
    skills: string;
    compaction: string;
  };
  /** Set only after the Host has resolved the backend route. */
  key?: string;
}

export interface ModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  total: number;
}

export type ModelStopReason = "stop" | "length" | "tool_use" | "error" | "aborted";

export interface ProviderResponseMetadata {
  responseId?: string;
  provider: string;
  api: string;
  model: string;
  responseModel?: string;
  protocol: ModelProtocol;
  usage: ModelUsage;
  stopReason: ModelStopReason;
  replay?: ProviderReplayState;
  cache: {
    key?: string;
    generation: string;
    readTokens: number;
    writeTokens: number;
  };
  timing: { startedAt: string; firstDeltaMs?: number; completedMs: number; attempts: number };
  /** Sanitized, bounded diagnostics safe for every Session reader. */
  diagnostics?: Array<{ code: string; message: string }>;
}

export interface NormalizedModelError {
  code:
    | "aborted"
    | "timeout"
    | "authentication"
    | "permission"
    | "rate_limit"
    | "invalid_request"
    | "provider_unavailable"
    | "protocol"
    | "unknown";
  message: string;
  retryable: boolean;
  status?: number;
}

export class ModelTransportError extends Error {
  readonly normalized: NormalizedModelError;
  readonly response: ProviderResponseMetadata;

  constructor(normalized: NormalizedModelError, response: ProviderResponseMetadata) {
    super(normalized.message);
    this.name = "ModelTransportError";
    this.normalized = normalized;
    this.response = response;
  }
}

export type ModelStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  /** Provider argument bytes, surfaced immediately; execution waits for tool_call. */
  | { type: "tool_call_delta"; id: string; name: string; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "completed"; response?: ProviderResponseMetadata };

export interface ModelTransport {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contentFingerprint(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function createModelCachePolicy(input: {
  mode?: ModelCachePolicy["mode"];
  retention?: ModelCachePolicy["retention"];
  systemPrompt: string;
  tools: readonly ModelToolName[];
  toolSchemas?: unknown;
  permissionScope: unknown;
  skillRevisions: readonly string[];
  compactionId?: string;
}): ModelCachePolicy {
  const invalidation = {
    prompt: contentFingerprint(input.systemPrompt),
    toolSchema: contentFingerprint(input.toolSchemas ?? input.tools),
    permissions: contentFingerprint(input.permissionScope),
    skills: contentFingerprint([...input.skillRevisions].sort()),
    compaction: contentFingerprint(input.compactionId ?? "uncompacted"),
  };
  return {
    mode: input.mode ?? "session",
    retention: input.retention ?? "short",
    generation: contentFingerprint(invalidation).slice(0, 24),
    invalidation,
  };
}

/** Derive an opaque affinity key after routing. Secrets and raw identities never leave the hash. */
export function deriveModelCacheKey(
  request: ModelRequest,
  route: { backendId: string; upstreamModelId: string; protocol: ModelProtocol },
) {
  if (
    !request.identity ||
    !request.cache ||
    request.cache.mode === "off" ||
    request.cache.retention === "none"
  )
    return undefined;
  return `ogc_${contentFingerprint({
    v: 1,
    host: request.identity.hostId,
    session: request.identity.sessionId,
    principal: request.identity.principalId,
    backend: route.backendId,
    model: route.upstreamModelId,
    protocol: route.protocol,
    generation: request.cache.generation,
  }).slice(0, 48)}`;
}

/** Stable socket affinity. Unlike a prompt cache key, it survives safe cache-generation changes. */
export function deriveModelConnectionKey(
  request: ModelRequest,
  route: { backendId: string; upstreamModelId: string; protocol: ModelProtocol },
) {
  if (!request.identity) return undefined;
  return `ogw_${contentFingerprint({
    v: 1,
    host: request.identity.hostId,
    session: request.identity.sessionId,
    principal: request.identity.principalId,
    backend: route.backendId,
    model: route.upstreamModelId,
    protocol: route.protocol,
  }).slice(0, 48)}`;
}

const SECRET_PATTERN = /(bearer\s+|api[_-]?key[=: ]+|token[=: ]+|sk-[a-z0-9_-]{6})[^\s,;"']+/gi;
export function redactProviderText(value: string, secrets: readonly string[] = []) {
  let result = value.replace(SECRET_PATTERN, "$1[REDACTED]");
  for (const secret of secrets) if (secret) result = result.replaceAll(secret, "[REDACTED]");
  return result.slice(0, 2_000);
}

export function normalizeModelError(error: unknown, signal?: AbortSignal): NormalizedModelError {
  if (error instanceof ModelTransportError) return error.normalized;
  const raw = error instanceof Error ? error.message : String(error);
  const message = redactProviderText(raw);
  const status =
    typeof (error as { status?: unknown })?.status === "number"
      ? (error as { status: number }).status
      : undefined;
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError"))
    return { code: "aborted", message: "Model request was aborted", retryable: false };
  if (/timed? ?out|timeout/i.test(message))
    return {
      code: "timeout",
      message: "Model provider request timed out",
      retryable: true,
      status,
    };
  if (status === 401)
    return {
      code: "authentication",
      message: "Model provider authentication failed",
      retryable: false,
      status,
    };
  if (status === 403)
    return {
      code: "permission",
      message: "Model provider denied the request because of entitlement and organization policy",
      retryable: false,
      status,
    };
  if (status === 429)
    return {
      code: "rate_limit",
      message: "Model provider rate limit reached",
      retryable: true,
      status,
    };
  if (
    /context[_ -]?length[_ -]?exceeded|input is too long|too many (?:input )?tokens/i.test(message)
  )
    return {
      code: "invalid_request",
      message: "Model request exceeds the provider context limit",
      retryable: false,
      status,
    };
  if (status === 400 || status === 404 || status === 422)
    return {
      code: "invalid_request",
      message: "Model provider rejected the request",
      retryable: false,
      status,
    };
  if ((status !== undefined && status >= 500) || /overloaded|unavailable/i.test(message))
    return {
      code: "provider_unavailable",
      message: "Model provider is unavailable",
      retryable: true,
      status,
    };
  if (/malformed|stream ended|protocol/i.test(message))
    return {
      code: "protocol",
      message: "Model provider returned an invalid stream",
      retryable: false,
      status,
    };
  return {
    code: "unknown",
    message: "Model provider request failed",
    retryable: false,
    status,
  };
}
