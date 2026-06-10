import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ClaudeAgentOptions, Message, Transport } from "./types.js";

export class CLINotFoundError extends Error {}
export class CLIConnectionError extends Error {}
export class CLIJSONDecodeError extends Error {}

export class SubprocessCLITransport implements Transport {
  private child?: ChildProcessWithoutNullStreams;
  private queue: Message[] = [];
  private waiters: Array<(v: IteratorResult<Message>) => void> = [];
  private done = false;
  private error?: Error;

  constructor(private options: ClaudeAgentOptions = {}) {}

  async connect(): Promise<void> {
    if (this.child) return;
    const cli =
      this.options.cliPath ?? this.options.pathToClaudeCodeExecutable ?? (await findClaude());
    const args = buildArgs(this.options);
    const env = {
      ...process.env,
      CLAUDE_CODE_ENTRYPOINT: this.options.entrypoint ?? "sdk-ts-lite",
      CLAUDE_AGENT_SDK_VERSION: "0.0.1",
      ...this.options.env,
    } as NodeJS.ProcessEnv;
    delete env.CLAUDECODE;
    this.child = spawn(cli, args, { cwd: this.options.cwd, env, stdio: "pipe" });
    this.child.on("error", (e) => this.finish(new CLIConnectionError(String(e))));
    this.child.on("exit", (code, signal) => {
      if (code && code !== 0)
        this.finish(
          new CLIConnectionError(`claude exited with code ${code}${signal ? ` (${signal})` : ""}`),
        );
      else this.finish();
    });
    this.child.stderr.on("data", (b) => this.options.stderr?.(b.toString()));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      try {
        this.push(JSON.parse(line));
      } catch (e) {
        this.finish(
          new CLIJSONDecodeError(
            `Invalid JSON from claude: ${line}\n${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }
    });
  }

  async write(message: unknown): Promise<void> {
    await this.writeRaw(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  }

  async writeRaw(data: string): Promise<void> {
    if (!this.child) throw new CLIConnectionError("transport is not connected");
    this.child.stdin.write(data);
  }

  async endInput(): Promise<void> {
    this.child?.stdin.end();
  }

  async disconnect(): Promise<void> {
    if (!this.child) return;
    this.child.stdin.end();
    const child = this.child;
    setTimeout(() => !child.killed && child.kill("SIGTERM"), 250).unref();
  }

  async interrupt(): Promise<void> {
    await this.write({ type: "interrupt" });
  }

  read(): AsyncIterable<Message> {
    return { [Symbol.asyncIterator]: () => ({ next: () => this.next() }) };
  }

  private next(): Promise<IteratorResult<Message>> {
    if (this.queue.length) return Promise.resolve({ value: this.queue.shift()!, done: false });
    if (this.error) return Promise.reject(this.error);
    if (this.done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  private push(m: Message): void {
    const w = this.waiters.shift();
    if (w) w({ value: m, done: false });
    else this.queue.push(m);
  }
  private finish(error?: Error): void {
    this.error ??= error;
    this.done = true;
    while (this.waiters.length) this.waiters.shift()!({ value: undefined, done: true });
  }
}

export async function findClaude(): Promise<string> {
  const paths = [
    "claude",
    join(homedir(), ".local/bin/claude"),
    join(homedir(), ".npm-global/bin/claude"),
    "/usr/local/bin/claude",
    join(homedir(), "node_modules/.bin/claude"),
    join(homedir(), ".yarn/bin/claude"),
    join(homedir(), ".claude/local/claude"),
  ];
  for (const p of paths) {
    const found = p === "claude" ? await which(p) : await executable(p);
    if (found) return found;
  }
  throw new CLINotFoundError(
    "Claude Code not found. Install with `npm install -g @anthropic-ai/claude-code`, ensure `claude` is on PATH, or pass { cliPath }.",
  );
}

async function executable(path: string): Promise<string | undefined> {
  try {
    await access(path, constants.X_OK);
    return path;
  } catch {
    return undefined;
  }
}
async function which(bin: string): Promise<string | undefined> {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, bin);
    if (await executable(p)) return p;
  }
}

export function buildArgs(o: ClaudeAgentOptions): string[] {
  const args = ["--output-format", "stream-json", "--verbose"];
  if (o.systemPrompt === null || o.systemPrompt === undefined) args.push("--system-prompt", "");
  else if (typeof o.systemPrompt === "string") args.push("--system-prompt", o.systemPrompt);
  else if (o.systemPrompt.type === "file") args.push("--system-prompt-file", o.systemPrompt.path);
  else if (o.systemPrompt.append) args.push("--append-system-prompt", o.systemPrompt.append);
  if (o.tools) args.push("--tools", Array.isArray(o.tools) ? o.tools.join(",") : "default");
  if (o.allowedTools?.length) args.push("--allowedTools", o.allowedTools.join(","));
  if (o.disallowedTools?.length) args.push("--disallowedTools", o.disallowedTools.join(","));
  if (o.maxTurns) args.push("--max-turns", String(o.maxTurns));
  if (o.model) args.push("--model", o.model);
  if (o.permissionPromptToolName) args.push("--permission-prompt-tool", o.permissionPromptToolName);
  if (o.permissionMode) args.push("--permission-mode", o.permissionMode);
  if (o.continueConversation) args.push("--continue");
  if (o.resume) args.push("--resume", o.resume);
  if (o.sessionId) args.push("--session-id", o.sessionId);
  if (o.settings) args.push("--settings", o.settings);
  for (const d of o.addDirs ?? []) args.push("--add-dir", d);
  if (o.mcpServers)
    args.push(
      "--mcp-config",
      typeof o.mcpServers === "string"
        ? o.mcpServers
        : JSON.stringify({ mcpServers: o.mcpServers }),
    );
  if (o.includePartialMessages) args.push("--include-partial-messages");
  if (o.includeHookEvents) args.push("--include-hook-events");
  if (o.strictMcpConfig) args.push("--strict-mcp-config");
  if (o.settingSources?.length) args.push(`--setting-sources=${o.settingSources.join(",")}`);
  if (o.enableFileCheckpointing) args.push("--enable-file-checkpointing");
  if (o.title) args.push("--title", o.title);
  if (o.maxThinkingTokens !== undefined)
    args.push("--max-thinking-tokens", String(o.maxThinkingTokens));
  if (o.thinking?.type === "disabled") args.push("--thinking", "disabled");
  if (o.thinking?.type === "adaptive") args.push("--thinking", "adaptive");
  if (o.thinking?.type === "enabled" && typeof o.thinking.budgetTokens === "number")
    args.push("--max-thinking-tokens", String(o.thinking.budgetTokens));
  for (const [k, v] of Object.entries(o.extraArgs ?? {})) {
    if (v == null || v === true) args.push(`--${k}`);
    else if (v !== false) args.push(`--${k}`, String(v));
  }
  args.push("--input-format", "stream-json");
  return args;
}
