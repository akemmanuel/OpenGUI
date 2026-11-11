/**
 * Runs OpenGUI model requests on Claude Code through the Claude Agent SDK.
 *
 * OpenGUI keeps its agent loop: tool execution, permissions, compaction and the transcript
 * stay in the Harness. Only the model call changes. Claude Code never runs a tool itself:
 * its built-in tools are off, and OpenGUI's tools reach it from an in-process MCP server
 * whose handlers hold each call until OpenGUI has run it and sends the result with the
 * next request. One Claude Code process serves one OpenGUI Session and is kept warm, so
 * the prompt cache and Claude Code's own context survive between requests.
 *
 * Adapted from the crocov3 Claude bridge (`scripts/claude-bridge/server.py`), in process.
 */
import { accessSync, constants, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  query as sdkQuery,
  type HookCallback,
  type McpSdkServerConfigWithInstance,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  calculateCost,
  parseStreamingJson,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  addUsage,
  assistantErrorMessage,
  checkpointContent,
  epoch,
  errorMessage,
  fingerprint,
  mcpBlocks,
  MCP_PREFIX,
  MCP_SERVER,
  mergeUsage,
  plan,
  toolNameMap,
  transcriptEntries,
  userContent,
  type ClaudeUsage,
  type ClaudeUserBlock,
  type UsageTotals,
} from "./protocol.ts";

/** How a request signs in to Claude. */
export type ClaudeCodeCredential =
  | { mode: "local" }
  | { mode: "oauth-token"; token: string }
  | { mode: "api-key"; key: string };

const LOCAL_LOGIN = "claude-code:local";
const OAUTH_TOKEN_PREFIX = "claude-code:oauth-token:";

/** Request auth as pi carries it: an opaque string in `apiKey`. */
export function encodeClaudeCodeCredential(credential: ClaudeCodeCredential) {
  if (credential.mode === "local") return LOCAL_LOGIN;
  if (credential.mode === "oauth-token") return `${OAUTH_TOKEN_PREFIX}${credential.token}`;
  return credential.key;
}

export function decodeClaudeCodeCredential(apiKey: string | undefined): ClaudeCodeCredential {
  if (!apiKey) throw new Error(errorMessage("not logged in: Claude Code has no credential"));
  if (apiKey === LOCAL_LOGIN) return { mode: "local" };
  if (apiKey.startsWith(OAUTH_TOKEN_PREFIX)) {
    return { mode: "oauth-token", token: apiKey.slice(OAUTH_TOKEN_PREFIX.length) };
  }
  return { mode: "api-key", key: apiKey };
}

/**
 * Claude Code reads none of the user's settings and adds nothing of its own: no CLAUDE.md,
 * memory, recaps, advisor, tool search, compaction, background tasks or telemetry. Held
 * tool calls wait for OpenGUI as long as a run may last.
 */
function isolationEnv(holdMs: number): Record<string, string> {
  return {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    DISABLE_AUTO_COMPACT: "1",
    CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
    ENABLE_TOOL_SEARCH: "false",
    CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_DISABLE_CRON: "1",
    CLAUDE_CODE_DISABLE_WORKFLOWS: "1",
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
    CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: "1",
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
    CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
    CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0",
    CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "0",
    MCP_TOOL_TIMEOUT: String(holdMs),
    MAX_MCP_OUTPUT_TOKENS: "200000",
    CLAUDE_AGENT_SDK_CLIENT_APP: "opengui",
  };
}

/** Ambient credentials that would silently override the selected sign-in. */
const AMBIENT_AUTH_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  // Set when OpenGUI itself runs inside Claude Code; the child must not think it is nested.
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
];

function executableExists(path: string) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The Claude Code executable: `OPENGUI_CLAUDE_CODE_EXECUTABLE`, else the native build the
 * Agent SDK ships for this platform, else an installed `claude`. A bundled backend (the
 * desktop app) has no SDK platform package, so it uses the installed Claude Code.
 */
export function resolveClaudeCodeExecutable(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.OPENGUI_CLAUDE_CODE_EXECUTABLE?.trim();
  if (configured) return configured;
  const name = process.platform === "win32" ? "claude.exe" : "claude";
  try {
    const sdkEntry = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
    const require = createRequire(sdkEntry);
    const platform = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    for (const candidate of [platform, `${platform}-musl`]) {
      try {
        const path = require.resolve(`${candidate}/${name}`);
        if (executableExists(path)) return path;
      } catch {
        /* Not installed for this platform. */
      }
    }
  } catch {
    /* Bundled backend: the SDK cannot be resolved as a package. */
  }
  const home = homedir();
  for (const directory of [
    ...(env.PATH ?? "").split(delimiter).filter(Boolean),
    // Desktop apps start with a minimal PATH; these are Claude Code's usual install places.
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]) {
    const path = join(directory, name);
    if (executableExists(path)) return path;
  }
  return undefined;
}

/** A single-consumer async queue. */
class PushQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  push(item: T) {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }

  close() {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}

class ClaudeCodeError extends Error {}

/** A block of a response being produced, as the runtime reports it. */
type JobEvent =
  | { type: "start" }
  | { type: "block_start"; index: number; kind: "text" | "thinking" }
  | { type: "block_start"; index: number; kind: "toolCall"; id: string; name: string }
  | { type: "delta"; index: number; delta: string }
  | { type: "block_end"; index: number; block: TextContent | ThinkingContent | ToolCall };

/**
 * One model response being produced. It outlives the request that started it, so a
 * retried request receives the same answer instead of a second one.
 */
class Job {
  readonly events: JobEvent[] = [];
  result: AssistantMessage | undefined;
  error: string | undefined;
  aborted = false;
  #listeners = new Set<() => void>();

  get done() {
    return this.result !== undefined || this.error !== undefined;
  }

  emit(event: JobEvent) {
    if (this.done) return;
    this.events.push(event);
    this.#notify();
  }

  finish(result: AssistantMessage) {
    if (this.done) return;
    this.result = result;
    this.#notify();
  }

  fail(error: string, aborted = false) {
    if (this.done) return;
    this.error = error;
    this.aborted = aborted;
    this.#notify();
  }

  #notify() {
    for (const listener of this.#listeners) listener();
  }

  /** Replays every event so far, then follows new ones until the job is done. */
  async *follow(signal?: AbortSignal): AsyncGenerator<JobEvent> {
    let index = 0;
    while (true) {
      while (index < this.events.length) yield this.events[index++]!;
      if (this.done || signal?.aborted) return;
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.#listeners.delete(wake);
          signal?.removeEventListener("abort", wake);
          resolve();
        };
        this.#listeners.add(wake);
        signal?.addEventListener("abort", wake, { once: true });
      });
    }
  }
}

interface SessionConfig {
  epoch: string;
  model: Model<Api>;
  systemPrompt: string;
  tools: Tool[];
  names: ReturnType<typeof toolNameMap>;
  effort?: Options["effort"];
  credential: ClaudeCodeCredential;
}

export interface ClaudeCodeRequest {
  key: string;
  model: Model<Api>;
  systemPrompt: string;
  tools: Tool[];
  messages: ReturnType<typeof transcriptEntries>;
  effort?: Options["effort"];
  credential: ClaudeCodeCredential;
}

export interface ClaudeCodeRuntimeOptions {
  /** Agent SDK `query`, replaceable in tests. */
  query?: (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;
  executable?: () => string | undefined;
  /** Working directory and isolated config for token and API-key sign-ins. */
  stateDirectory?: string;
  /** Live processes kept at most (least recently used idle ones stop first). */
  maxSessions?: number;
  /** An idle process stops after this long. */
  idleMs?: number;
  /** A process holding tool calls waits this long for their results. */
  holdMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
}

const DEFAULT_IDLE_MS = 10 * 60_000;
/** As long as a run may last. */
const DEFAULT_HOLD_MS = 2 * 60 * 60_000;

class Session {
  readonly key: string;
  readonly #runtime: ClaudeCodeRuntime;
  cfg: SessionConfig | undefined;
  query: Query | undefined;
  #input: PushQueue<SDKUserMessage> | undefined;
  #inbox: PushQueue<SDKMessage | ClaudeCodeError> | undefined;
  records: string[] = [];
  response: string | null = null;
  held: string[] = [];
  #waiting = new Map<string, (result: CallToolResult) => void>();
  #ready = new Map<string, CallToolResult>();
  #currentCall: string | undefined;
  /** API message ids seen as stream events; their whole-message copies arrive later. */
  #streamed = new Set<string>();
  job: Job | undefined;
  used: number;
  #lock: Promise<unknown> = Promise.resolve();

  constructor(key: string, runtime: ClaudeCodeRuntime) {
    this.key = key;
    this.#runtime = runtime;
    this.used = runtime.now();
  }

  get busy() {
    return Boolean(this.job && !this.job.done);
  }

  /** Serializes request handling for this Session. */
  locked<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#lock.then(task, task);
    this.#lock = next.catch(() => undefined);
    return next;
  }

  #mcpServer(cfg: SessionConfig) {
    const server = new Server(
      { name: "opengui", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: cfg.tools.map((tool) => {
        const schema = JSON.parse(JSON.stringify(tool.parameters ?? {})) as Record<string, unknown>;
        return {
          name: cfg.names.toClaude.get(tool.name)!,
          description: tool.description,
          inputSchema: { ...schema, type: "object" },
        };
      }),
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => this.#toolCall());
    return server;
  }

  /** Holds a call until OpenGUI sends its result with the next request. */
  async #toolCall(): Promise<CallToolResult> {
    const call = this.#currentCall;
    this.#currentCall = undefined;
    if (!call) {
      return {
        content: [{ type: "text", text: "This tool call could not be matched." }],
        isError: true,
      };
    }
    const ready = this.#ready.get(call);
    if (ready) {
      this.#ready.delete(call);
      return ready;
    }
    return await new Promise<CallToolResult>((resolve) => this.#waiting.set(call, resolve));
  }

  #beforeTool: HookCallback = async (input, toolUseId) => {
    const id =
      toolUseId ??
      ("tool_use_id" in input ? (input as { tool_use_id?: string }).tool_use_id : undefined);
    this.#currentCall = id;
    return {};
  };

  #resolve(call: string, result: CallToolResult) {
    const waiter = this.#waiting.get(call);
    if (waiter) {
      this.#waiting.delete(call);
      waiter(result);
    } else {
      this.#ready.set(call, result);
    }
  }

  async start(cfg: SessionConfig) {
    await this.stop();
    this.cfg = cfg;
    const runtime = this.#runtime;
    const credential = cfg.credential;
    const env: Record<string, string | undefined> = { ...process.env };
    for (const name of AMBIENT_AUTH_ENV) delete env[name];
    Object.assign(env, isolationEnv(runtime.holdMs));
    if (credential.mode !== "local") {
      // Never touch the user's own Claude Code login or settings with another credential.
      env.CLAUDE_CONFIG_DIR = runtime.directory("config");
      if (credential.mode === "oauth-token") env.CLAUDE_CODE_OAUTH_TOKEN = credential.token;
      else env.ANTHROPIC_API_KEY = credential.key;
    }
    const allowed = cfg.tools.map((tool) => `${MCP_PREFIX}${cfg.names.toClaude.get(tool.name)}`);
    const server: McpSdkServerConfigWithInstance = {
      type: "sdk",
      name: MCP_SERVER,
      timeout: runtime.holdMs,
      // The SDK only calls `connect()`; the low-level server keeps OpenGUI's JSON Schemas as given.
      instance: this.#mcpServer(cfg) as unknown as McpSdkServerConfigWithInstance["instance"],
    };
    const executable = runtime.executable();
    if (!executable) {
      throw new ClaudeCodeError(
        "Claude Code request failed: Claude Code is not installed. Install it from https://claude.com/claude-code or set OPENGUI_CLAUDE_CODE_EXECUTABLE to its path.",
      );
    }
    const input = new PushQueue<SDKUserMessage>();
    const inbox = new PushQueue<SDKMessage | ClaudeCodeError>();
    const query = runtime.query({
      prompt: input,
      options: {
        model: cfg.model.id,
        ...(cfg.effort ? { effort: cfg.effort } : {}),
        systemPrompt: cfg.systemPrompt,
        tools: [],
        mcpServers: { [MCP_SERVER]: server },
        allowedTools: allowed,
        strictMcpConfig: true,
        permissionMode: "dontAsk",
        settingSources: [],
        includePartialMessages: true,
        verbatimPrompts: true,
        persistSession: false,
        thinking: { type: "adaptive", display: "summarized" },
        hooks: { PreToolUse: [{ hooks: [this.#beforeTool] }] },
        cwd: runtime.directory("work"),
        env,
        pathToClaudeCodeExecutable: executable,
        stderr: (line) =>
          runtime.log("Claude Code stderr", { session: this.key, line: line.slice(0, 500) }),
      },
    });
    this.query = query;
    this.#input = input;
    this.#inbox = inbox;
    void (async () => {
      try {
        for await (const message of query) inbox.push(message);
        inbox.push(new ClaudeCodeError(errorMessage("Claude Code ended the session")));
      } catch (error) {
        inbox.push(
          new ClaudeCodeError(errorMessage(error instanceof Error ? error.message : String(error))),
        );
      }
    })();
    runtime.log("Claude Code session started", {
      session: this.key,
      model: cfg.model.id,
      mode: credential.mode,
      tools: allowed.length,
    });
  }

  async stop() {
    this.#waiting.clear();
    this.#ready.clear();
    this.#streamed.clear();
    this.#currentCall = undefined;
    if (this.job && !this.job.done) this.job.fail(errorMessage("Claude Code session closed"));
    this.job = undefined;
    this.#inbox?.push(new ClaudeCodeError(errorMessage("Claude Code session closed")));
    this.#input?.close();
    const query = this.query;
    this.query = this.#input = this.#inbox = undefined;
    if (query) {
      try {
        query.close();
      } catch {
        /* Already closed. */
      }
    }
  }

  #send(content: ClaudeUserBlock[]) {
    this.#input?.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    } as SDKUserMessage);
  }

  /** Delivers what the process has not seen and returns the Job for the next response. */
  async step(request: ClaudeCodeRequest): Promise<Job> {
    const cfg: SessionConfig = {
      epoch: epoch({
        systemPrompt: request.systemPrompt,
        tools: request.tools,
        model: request.model.id,
        effort: request.effort,
        credential: encodeClaudeCodeCredential(request.credential),
      }),
      model: request.model,
      systemPrompt: request.systemPrompt,
      tools: request.tools,
      names: toolNameMap(request.tools),
      effort: request.effort,
      credential: request.credential,
    };
    const entries = request.messages;
    this.used = this.#runtime.now();
    const same = this.cfg?.epoch === cfg.epoch;
    let next = same
      ? plan(this.records, this.response, this.held, entries)
      : { kind: "fresh" as const };
    const running = Boolean(this.job && !this.job.done);
    if (next.kind === "retry" && this.job && this.query && (running || this.job.result)) {
      return this.job;
    }
    if (next.kind === "continue" && (running || !this.query)) next = { kind: "fresh" };
    const fingerprints = entries.map(fingerprint);
    if (next.kind !== "continue") {
      await this.start(cfg);
      this.records = fingerprints;
      this.response = null;
      this.held = [];
      this.#send(checkpointContent(entries));
      this.#runtime.log("Fresh Claude Code session", {
        session: this.key,
        entries: entries.length,
      });
    } else {
      this.cfg = cfg;
      this.records = fingerprints;
      this.response = null;
      this.held = [];
      this.#ready.clear();
      // Messages that arrived during a tool batch are queued first: Claude Code hands them
      // to Claude as user messages right after the batch's results, not inside them.
      if (next.users.length > 0) this.#send(userContent(next.users));
      for (const result of next.results) {
        this.#resolve(result.toolCallId, {
          content: mcpBlocks(result.content),
          isError: result.isError,
        });
      }
    }
    const job = new Job();
    this.job = job;
    void this.#produce(job, this.#inbox!, cfg);
    return job;
  }

  async #produce(job: Job, inbox: PushQueue<SDKMessage | ClaudeCodeError>, cfg: SessionConfig) {
    try {
      const message = await this.#collect(job, inbox, cfg);
      if (this.job !== job) return;
      this.held = message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
      this.response = fingerprint(message);
      this.records.push(this.response);
      job.finish(message);
      // A request without tools (a compaction summary) is a one-off.
      if (cfg.tools.length === 0) await this.stop();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.#runtime.log("Claude Code response failed", {
        session: this.key,
        error: text.slice(0, 500),
      });
      job.fail(text);
      if (this.job === job) await this.stop();
    } finally {
      this.used = this.#runtime.now();
    }
  }

  /** Collects one response from Claude Code's stream into the job. */
  async #collect(
    job: Job,
    inbox: PushQueue<SDKMessage | ClaudeCodeError>,
    cfg: SessionConfig,
  ): Promise<AssistantMessage> {
    const content: AssistantMessage["content"] = [];
    const indexes = new Map<number, number>();
    const partialJson = new Map<number, string>();
    const streamed = this.#streamed;
    const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let stepUsage: ClaudeUsage = {};
    let stopReason: string | null = null;
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      job.emit({ type: "start" });
    };
    const finish = () => this.#response(cfg, content, totals, stopReason);

    while (true) {
      const next = await inbox.next();
      if (next.done) throw new ClaudeCodeError(errorMessage("Claude Code session closed"));
      const message = next.value;
      if (message instanceof ClaudeCodeError) throw message;
      if (message.type === "rate_limit_event") {
        const info = message.rate_limit_info;
        if (info.status === "rejected") {
          const resets = info.resetsAt
            ? `; resets at ${new Date(info.resetsAt * 1000).toISOString()}`
            : "";
          throw new ClaudeCodeError(
            errorMessage(`usage limit reached (${info.rateLimitType ?? "plan"})${resets}`),
          );
        }
        continue;
      }
      if (message.type === "stream_event") {
        if (message.parent_tool_use_id) continue;
        const event = message.event as unknown as StreamEvent;
        if (event.type === "message_start") {
          start();
          indexes.clear();
          partialJson.clear();
          if (event.message?.id) streamed.add(event.message.id);
          stepUsage = event.message?.usage ?? {};
        } else if (event.type === "content_block_start") {
          start();
          const block = event.content_block ?? {};
          const index = content.length;
          if (block.type === "text") {
            content.push({ type: "text", text: "" });
            indexes.set(event.index, index);
            job.emit({ type: "block_start", index, kind: "text" });
          } else if (block.type === "thinking") {
            content.push({ type: "thinking", thinking: "" });
            indexes.set(event.index, index);
            job.emit({ type: "block_start", index, kind: "thinking" });
          } else if (block.type === "tool_use" && block.name?.startsWith(MCP_PREFIX)) {
            const name =
              cfg.names.fromClaude.get(block.name.slice(MCP_PREFIX.length)) ?? block.name;
            content.push({ type: "toolCall", id: block.id ?? "", name, arguments: {} });
            indexes.set(event.index, index);
            partialJson.set(event.index, "");
            job.emit({ type: "block_start", index, kind: "toolCall", id: block.id ?? "", name });
          }
        } else if (event.type === "content_block_delta") {
          const index = indexes.get(event.index);
          const block = index === undefined ? undefined : content[index];
          const delta = event.delta ?? {};
          if (!block || index === undefined) continue;
          if (block.type === "text" && delta.type === "text_delta" && delta.text) {
            block.text += delta.text;
            job.emit({ type: "delta", index, delta: delta.text });
          } else if (
            block.type === "thinking" &&
            delta.type === "thinking_delta" &&
            delta.thinking
          ) {
            block.thinking += delta.thinking;
            job.emit({ type: "delta", index, delta: delta.thinking });
          } else if (
            block.type === "toolCall" &&
            delta.type === "input_json_delta" &&
            delta.partial_json
          ) {
            partialJson.set(event.index, (partialJson.get(event.index) ?? "") + delta.partial_json);
            job.emit({ type: "delta", index, delta: delta.partial_json });
          }
        } else if (event.type === "content_block_stop") {
          const index = indexes.get(event.index);
          const block = index === undefined ? undefined : content[index];
          if (!block || index === undefined) continue;
          if (block.type === "toolCall") {
            block.arguments = parseStreamingJson(partialJson.get(event.index) || "{}");
          }
          job.emit({ type: "block_end", index, block: structuredClone(block) });
        } else if (event.type === "message_delta") {
          stopReason = event.delta?.stop_reason ?? stopReason;
          stepUsage = mergeUsage(stepUsage, event.usage);
        } else if (event.type === "message_stop") {
          addUsage(totals, stepUsage);
          stepUsage = {};
          // Our tool calls end the response; Claude Code now waits in the MCP handlers.
          if (stopReason === "tool_use" && content.some((block) => block.type === "toolCall")) {
            return finish();
          }
        }
        continue;
      }
      if (message.type === "assistant") {
        if (message.parent_tool_use_id) continue;
        if (message.error) throw new ClaudeCodeError(assistantErrorMessage(message.error));
        const id = message.message.id;
        if (id && streamed.has(id)) continue;
        // Without partial messages (an older Claude Code), take the blocks whole.
        start();
        for (const block of message.message.content as unknown as StreamBlock[]) {
          const index = content.length;
          if (block.type === "text" && block.text) {
            content.push({ type: "text", text: block.text });
            job.emit({ type: "block_start", index, kind: "text" });
            job.emit({ type: "delta", index, delta: block.text });
            job.emit({ type: "block_end", index, block: { type: "text", text: block.text } });
          } else if (block.type === "tool_use" && block.name?.startsWith(MCP_PREFIX)) {
            const name =
              cfg.names.fromClaude.get(block.name.slice(MCP_PREFIX.length)) ?? block.name;
            const call: ToolCall = {
              type: "toolCall",
              id: block.id ?? "",
              name,
              arguments: (block.input ?? {}) as ToolCall["arguments"],
            };
            content.push(call);
            job.emit({ type: "block_start", index, kind: "toolCall", id: call.id, name });
            job.emit({ type: "block_end", index, block: structuredClone(call) });
          }
        }
        stopReason = message.message.stop_reason ?? stopReason;
        addUsage(totals, (message.message.usage ?? {}) as ClaudeUsage);
        if (stopReason === "tool_use" && content.some((block) => block.type === "toolCall")) {
          return finish();
        }
        continue;
      }
      if (message.type === "result") {
        if (message.is_error || message.subtype !== "success") {
          const detail =
            ("result" in message && message.result) ||
            ("errors" in message && message.errors?.join("; ")) ||
            message.subtype;
          const status =
            "api_error_status" in message && message.api_error_status
              ? `HTTP ${message.api_error_status}: `
              : "";
          throw new ClaudeCodeError(errorMessage(`${status}${detail}`));
        }
        start();
        return finish();
      }
    }
  }

  #response(
    cfg: SessionConfig,
    content: AssistantMessage["content"],
    totals: UsageTotals,
    stopReason: string | null,
  ): AssistantMessage {
    const calls = content.some((block) => block.type === "toolCall");
    const usage: AssistantMessage["usage"] = {
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      ...(totals.cacheWrite1h === undefined
        ? {}
        : { cacheWrite1h: Math.min(totals.cacheWrite, totals.cacheWrite1h) }),
      totalTokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    // Standard API prices: an estimate of what the same tokens would cost on the API.
    usage.cost = calculateCost(cfg.model, usage);
    return {
      role: "assistant",
      content: content.filter(
        (block) =>
          block.type === "toolCall" ||
          (block.type === "text" && block.text.length > 0) ||
          (block.type === "thinking" && block.thinking.trim().length > 0),
      ),
      api: cfg.model.api,
      provider: cfg.model.provider,
      model: cfg.model.id,
      usage,
      stopReason: calls ? "toolUse" : stopReason === "max_tokens" ? "length" : "stop",
      ...(stopReason ? { rawStopReason: stopReason } : {}),
      timestamp: this.#runtime.now(),
      responseId: `claude-code:${crypto.randomUUID()}`,
    };
  }
}

/** The subset of Anthropic stream events the runtime reads. */
interface StreamBlock {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  input?: unknown;
}
interface StreamEvent {
  type: string;
  index: number;
  message?: { id?: string; usage?: ClaudeUsage };
  content_block?: StreamBlock;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: ClaudeUsage;
}

/** Claude Code processes for OpenGUI Sessions, with idle and least-recently-used eviction. */
export class ClaudeCodeRuntime {
  readonly #options: ClaudeCodeRuntimeOptions;
  readonly #sessions = new Map<string, Session>();
  readonly holdMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #executable: string | undefined | null = null;

  constructor(options: ClaudeCodeRuntimeOptions = {}) {
    this.#options = options;
    this.holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
  }

  now() {
    return (this.#options.now ?? Date.now)();
  }

  log(message: string, fields?: Record<string, unknown>) {
    this.#options.log?.(message, fields);
  }

  query(input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) {
    return (this.#options.query ?? sdkQuery)(input);
  }

  executable() {
    if (this.#executable === null) {
      this.#executable = (this.#options.executable ?? resolveClaudeCodeExecutable)();
    }
    return this.#executable;
  }

  directory(name: "work" | "config") {
    const root = this.#options.stateDirectory ?? join(tmpdir(), "opengui-claude-code");
    const path = join(root, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  }

  /** Starts or continues the Session's response; the Job outlives the caller. */
  async step(request: ClaudeCodeRequest) {
    let session = this.#sessions.get(request.key);
    if (!session) {
      session = new Session(request.key, this);
      this.#sessions.set(request.key, session);
    }
    this.#schedule();
    const current = session;
    const job = await current.locked(() => current.step(request));
    await this.#limit(current);
    return { job, session: current };
  }

  /** Stops a Session's process; its next request starts fresh. */
  async abort(session: Session, job: Job) {
    if (session.job !== job || job.done) return;
    job.fail(errorMessage("Model request was aborted"), true);
    await session.stop();
    session.records = [];
    session.response = null;
    session.held = [];
  }

  #schedule() {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.sweep().catch(() => undefined), 30_000);
    this.#timer.unref?.();
  }

  async #limit(keep: Session) {
    const max = Math.max(1, this.#options.maxSessions ?? 6);
    const live = [...this.#sessions.values()].filter((session) => session.query);
    if (live.length <= max) return;
    const idle = live
      .filter((session) => session !== keep && !session.busy)
      .sort((left, right) => left.used - right.used);
    for (const session of idle.slice(0, live.length - max)) {
      this.log("Stopping least recently used Claude Code session", { session: session.key });
      await session.locked(async () => {
        await session.stop();
        session.held = [];
      });
    }
  }

  /** Stops idle processes; one holding tool calls waits as long as a run may last. */
  async sweep() {
    const now = this.now();
    const idleMs = this.#options.idleMs ?? DEFAULT_IDLE_MS;
    for (const [key, session] of this.#sessions) {
      if (session.busy) continue;
      if (!session.query) {
        if (now - session.used > idleMs) this.#sessions.delete(key);
        continue;
      }
      const limit = session.held.length > 0 ? this.holdMs : idleMs;
      if (now - session.used <= limit) continue;
      this.log("Stopping idle Claude Code session", { session: key, held: session.held.length });
      await session.locked(async () => {
        await session.stop();
        if (session.held.length > 0) {
          session.records = [];
          session.response = null;
          session.held = [];
        }
      });
    }
  }

  liveSessions() {
    return [...this.#sessions.values()].filter((session) => session.query).length;
  }

  async close() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await Promise.all([...this.#sessions.values()].map((session) => session.stop()));
    this.#sessions.clear();
  }
}

/** Streams a Job into a pi event stream, building that stream's own partial message. */
export async function writeJob(input: {
  stream: AssistantMessageEventStream;
  job: Job;
  model: Model<Api>;
  signal?: AbortSignal;
  onAbort: () => Promise<void>;
  started: number;
}) {
  const { stream, job, model, signal } = input;
  const partial: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: input.started,
  };
  let started = false;
  const begin = () => {
    if (started) return;
    started = true;
    stream.push({ type: "start", partial });
  };
  const fail = (message: string, aborted: boolean) => {
    const error: AssistantMessage = {
      ...partial,
      stopReason: aborted ? "aborted" : "error",
      errorMessage: aborted ? "Request was aborted" : message,
    };
    stream.push({ type: "error", reason: aborted ? "aborted" : "error", error });
    stream.end(error);
  };
  const abort = () => void input.onAbort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) {
      await input.onAbort();
      return fail("Request was aborted", true);
    }
    for await (const event of job.follow(signal)) {
      if (event.type === "start") {
        begin();
      } else if (event.type === "block_start") {
        begin();
        const contentIndex = event.index;
        if (event.kind === "text") {
          partial.content[contentIndex] = { type: "text", text: "" };
          stream.push({ type: "text_start", contentIndex, partial });
        } else if (event.kind === "thinking") {
          partial.content[contentIndex] = { type: "thinking", thinking: "" };
          stream.push({ type: "thinking_start", contentIndex, partial });
        } else if (event.kind === "toolCall") {
          partial.content[contentIndex] = {
            type: "toolCall",
            id: event.id,
            name: event.name,
            arguments: {},
          };
          stream.push({ type: "toolcall_start", contentIndex, partial });
        }
      } else if (event.type === "delta") {
        const contentIndex = event.index;
        const block = partial.content[contentIndex];
        if (block?.type === "text") {
          block.text += event.delta;
          stream.push({ type: "text_delta", contentIndex, delta: event.delta, partial });
        } else if (block?.type === "thinking") {
          block.thinking += event.delta;
          stream.push({ type: "thinking_delta", contentIndex, delta: event.delta, partial });
        } else if (block?.type === "toolCall") {
          stream.push({ type: "toolcall_delta", contentIndex, delta: event.delta, partial });
        }
      } else {
        const contentIndex = event.index;
        partial.content[contentIndex] = event.block;
        if (event.block.type === "text") {
          stream.push({ type: "text_end", contentIndex, content: event.block.text, partial });
        } else if (event.block.type === "thinking") {
          stream.push({
            type: "thinking_end",
            contentIndex,
            content: event.block.thinking,
            partial,
          });
        } else {
          stream.push({ type: "toolcall_end", contentIndex, toolCall: event.block, partial });
        }
      }
    }
    if (signal?.aborted) {
      await input.onAbort();
      return fail("Request was aborted", true);
    }
    if (job.result) {
      begin();
      const reason =
        job.result.stopReason === "toolUse"
          ? "toolUse"
          : job.result.stopReason === "length"
            ? "length"
            : "stop";
      stream.push({ type: "done", reason, message: job.result });
      stream.end(job.result);
      return;
    }
    fail(job.error ?? errorMessage("Claude Code returned no response"), job.aborted);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

export type { Job, Session };
