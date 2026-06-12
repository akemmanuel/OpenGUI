import type {
  ClaudeAgentOptions,
  HookCallback,
  Message,
  PermissionResult,
  Transport,
} from "./types.js";

type Pending = {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export class SDKQuery implements AsyncIterable<Message> {
  private pending = new Map<string, Pending>();
  private hookCallbacks = new Map<string, HookCallback>();
  private callbackSeq = 0;
  private requestSeq = 0;
  private queue: Message[] = [];
  private waiters: Array<(r: IteratorResult<Message>) => void> = [];
  private waiterRejects: Array<(e: Error) => void> = [];
  private closed = false;
  private streamError?: Error;
  private initResult?: Record<string, unknown> | null;
  private initResolve!: (value: Record<string, unknown> | null) => void;
  private initPromise = new Promise<Record<string, unknown> | null>((resolve) => {
    this.initResolve = resolve;
  });
  private readerDone: Promise<void>;
  private transport: Transport;
  private options: ClaudeAgentOptions;

  constructor(transport: Transport, options: ClaudeAgentOptions = {}) {
    this.transport = transport;
    this.options = options;
    this.readerDone = this.readLoop();
  }

  async initialize(): Promise<Record<string, unknown> | null> {
    const hooks = this.buildHooksConfig();
    this.initResult = await this.control(
      { subtype: "initialize", hooks: Object.keys(hooks).length ? hooks : null },
      60_000,
    );
    this.initResolve(this.initResult);
    return this.initResult;
  }

  initializationResult(): Promise<Record<string, unknown> | null> {
    return this.initResult !== undefined ? Promise.resolve(this.initResult) : this.initPromise;
  }
  async supportedModels(): Promise<unknown[]> {
    const fromInit = extractModels(this.initResult);
    if (fromInit.length) return fromInit;
    for (const subtype of ["supported_models", "get_supported_models", "models"]) {
      try {
        const r = await this.control({ subtype });
        const models = extractModels(r);
        if (models.length) return models;
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (!text.includes("Unsupported control request subtype")) throw error;
      }
    }
    return [];
  }
  getSettings(): Promise<Record<string, unknown>> {
    return this.control({ subtype: "get_settings" });
  }
  mcpServerStatus(): Promise<unknown[]> {
    return this.control({ subtype: "mcp_status" }).then(
      (r) => (r.servers ?? r.mcpServers ?? r.status ?? []) as unknown[],
    );
  }
  getContextUsage(): Promise<Record<string, unknown>> {
    return this.control({ subtype: "get_context_usage" });
  }
  interrupt(): Promise<unknown> {
    return this.control({ subtype: "interrupt" });
  }
  setPermissionMode(mode: string): Promise<unknown> {
    return this.control({ subtype: "set_permission_mode", mode });
  }
  setModel(model: string | null): Promise<unknown> {
    return this.control({ subtype: "set_model", model });
  }
  rewindFiles(
    userMessageId: string,
    opts?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.control({ subtype: "rewind_files", user_message_id: userMessageId, ...opts });
  }
  reconnectMcpServer(serverName: string): Promise<unknown> {
    return this.control({ subtype: "mcp_reconnect", serverName });
  }
  toggleMcpServer(serverName: string, enabled: boolean): Promise<unknown> {
    return this.control({ subtype: "mcp_toggle", serverName, enabled });
  }
  setMcpServers(mcpServers: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.control({ subtype: "mcp_set_servers", mcpServers });
  }
  mcpAuthenticate(serverName: string): Promise<Record<string, unknown>> {
    return this.control({ subtype: "mcp_authenticate", serverName });
  }
  mcpClearAuth(serverName: string): Promise<Record<string, unknown>> {
    return this.control({ subtype: "mcp_clear_auth", serverName });
  }
  mcpSubmitOAuthCallbackUrl(
    serverName: string,
    callbackUrl: string,
  ): Promise<Record<string, unknown>> {
    return this.control({ subtype: "mcp_submit_oauth_callback_url", serverName, callbackUrl });
  }
  messageRated(data: Record<string, unknown>): Promise<unknown> {
    return this.control({ subtype: "message_rated", ...data });
  }
  submitFeedback(
    description: string,
    data?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.control({ subtype: "submit_feedback", description, ...data });
  }
  generateSessionTitle(
    description: string,
    data?: Record<string, unknown>,
  ): Promise<string | null> {
    return this.control({ subtype: "generate_session_title", description, ...data }).then(
      (r) => (r.title as string) ?? null,
    );
  }
  claudeAuthenticate(useClaudeAi: boolean): Promise<Record<string, unknown>> {
    return this.control({ subtype: "claude_authenticate", useClaudeAi });
  }
  claudeOAuthWaitForCompletion(): Promise<Record<string, unknown>> {
    return this.control({ subtype: "claude_oauth_wait_for_completion" }, 300_000);
  }
  claudeOAuthCallback(code: string, state?: string): Promise<Record<string, unknown>> {
    return this.control({ subtype: "claude_oauth_callback", code, state });
  }
  enableRemoteControl(enable: boolean): Promise<Record<string, unknown>> {
    return this.control({ subtype: "enable_remote_control", enable });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.transport.disconnect();
    await this.readerDone.catch(() => {});
  }
  async return(): Promise<IteratorResult<Message>> {
    await this.close();
    return { value: undefined, done: true };
  }
  [Symbol.asyncIterator](): AsyncIterator<Message> {
    return { next: () => this.next(), return: () => this.return() };
  }

  private buildHooksConfig(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [event, matchers] of Object.entries(this.options.hooks ?? {})) {
      out[event] = matchers.map((m) => {
        const hookCallbackIds = (m.hooks ?? []).map((cb) => {
          const id = `hook_${this.callbackSeq++}`;
          this.hookCallbacks.set(id, cb);
          return id;
        });
        return {
          matcher: m.matcher,
          hookCallbackIds,
          ...(m.timeout ? { timeout: m.timeout } : {}),
        };
      });
    }
    return out;
  }

  private async control(
    request: Record<string, unknown>,
    timeoutMs = 60_000,
  ): Promise<Record<string, unknown>> {
    const request_id = `req_${++this.requestSeq}_${Math.random().toString(16).slice(2)}`;
    await (this.transport.writeRaw?.(
      JSON.stringify({ type: "control_request", request_id, request }) + "\n",
    ) ?? this.transport.write({ type: "control_request", request_id, request }));
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        reject(new Error(`Control request timeout: ${String(request.subtype)}`));
      }, timeoutMs);
      this.pending.set(request_id, { resolve, reject, timer });
    });
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const msg of this.transport.read()) {
        if (this.closed) break;
        if (msg.type === "control_response") {
          this.handleControlResponse(msg);
          continue;
        }
        if (msg.type === "control_request") {
          void this.handleControlRequest(msg);
          continue;
        }
        if (msg.type === "control_cancel_request") continue;
        this.push(msg);
      }
    } catch (error) {
      this.fail(error);
    } finally {
      if (!this.streamError) this.finish();
    }
  }

  private handleControlResponse(msg: Message): void {
    const response = msg.response as Record<string, unknown> | undefined;
    const id = response?.request_id as string | undefined;
    const p = id ? this.pending.get(id) : undefined;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id!);
    if (response?.subtype === "error") {
      const message =
        typeof response.error === "string"
          ? response.error
          : JSON.stringify(response.error ?? "Unknown control error");
      p.reject(new Error(message));
    } else p.resolve((response?.response as Record<string, unknown>) ?? {});
  }

  private async handleControlRequest(msg: Message): Promise<void> {
    const request_id = msg.request_id as string;
    const request = msg.request as Record<string, unknown>;
    try {
      let response: Record<string, unknown> = {};
      if (request.subtype === "can_use_tool") response = await this.handlePermission(request);
      else if (request.subtype === "hook_callback") response = await this.handleHook(request);
      else throw new Error(`Unsupported control request subtype: ${String(request.subtype)}`);
      await this.writeControlResponse({ subtype: "success", request_id, response });
    } catch (e) {
      await this.writeControlResponse({
        subtype: "error",
        request_id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async handlePermission(r: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.options.canUseTool) throw new Error("canUseTool callback is not provided");
    const input = (r.input && typeof r.input === "object" ? r.input : {}) as Record<
      string,
      unknown
    >;
    const result = await this.options.canUseTool(String(r.tool_name), input, {
      suggestions: (r.permission_suggestions as Record<string, unknown>[]) ?? [],
      toolUseID: r.tool_use_id as string,
      tool_use_id: r.tool_use_id as string,
      agentID: r.agent_id as string,
      agent_id: r.agent_id as string,
      blockedPath: r.blocked_path as string,
      blocked_path: r.blocked_path as string,
      decisionReason: r.decision_reason as string,
      decision_reason: r.decision_reason as string,
      title: r.title as string,
      displayName: r.display_name as string,
      display_name: r.display_name as string,
      description: r.description as string,
      signal: null,
    });
    return normalizePermissionResult(result, input);
  }

  private async handleHook(r: Record<string, unknown>): Promise<Record<string, unknown>> {
    const cb = this.hookCallbacks.get(String(r.callback_id));
    if (!cb) throw new Error(`No hook callback found for ID: ${String(r.callback_id)}`);
    return await cb(r.input, r.tool_use_id as string, { signal: null });
  }

  private async writeControlResponse(response: Record<string, unknown>): Promise<void> {
    await (this.transport.writeRaw?.(
      JSON.stringify({ type: "control_response", response }) + "\n",
    ) ?? this.transport.write({ type: "control_response", response }));
  }
  private next(): Promise<IteratorResult<Message>> {
    if (this.streamError) return Promise.reject(this.streamError);
    if (this.queue.length) return Promise.resolve({ value: this.queue.shift()!, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => {
      this.waiters.push(resolve);
      this.waiterRejects.push(reject);
    });
  }
  private push(m: Message): void {
    const w = this.waiters.shift();
    if (w) w({ value: m, done: false });
    else this.queue.push(m);
  }
  private finish(): void {
    this.closed = true;
    while (this.waiters.length) {
      this.waiterRejects.shift();
      this.waiters.shift()!({ value: undefined, done: true });
    }
  }
  fail(error: unknown): void {
    this.streamError = error instanceof Error ? error : new Error(String(error));
    this.closed = true;
    while (this.waiterRejects.length) this.waiterRejects.shift()!(this.streamError);
    this.waiters = [];
    this.initResolve(null);
  }
}

function normalizePermissionResult(
  result: PermissionResult,
  originalInput: Record<string, unknown>,
): Record<string, unknown> {
  if (result.behavior === "allow")
    return {
      behavior: "allow",
      updatedInput: result.updatedInput ?? originalInput,
      ...(result.updatedPermissions ? { updatedPermissions: result.updatedPermissions } : {}),
    };
  return {
    behavior: "deny",
    message: result.message ?? "",
    ...(result.interrupt ? { interrupt: true } : {}),
  };
}

function extractModels(source: Record<string, unknown> | null | undefined): unknown[] {
  if (!source) return [];
  for (const key of [
    "supportedModels",
    "supported_models",
    "models",
    "availableModels",
    "available_models",
  ]) {
    const value = source[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}
