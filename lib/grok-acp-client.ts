// @ts-nocheck
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export type GrokAcpNotification = {
  method: string;
  params?: Record<string, unknown>;
};

export type GrokAcpClientOptions = {
  executable?: string;
  onNotification?: (notification: GrokAcpNotification) => void;
  requestTimeoutMs?: number;
};

export class GrokAcpClient {
  #executable: string;
  #onNotification: (notification: GrokAcpNotification) => void;
  #requestTimeoutMs: number;
  #child: ChildProcess | null = null;
  #rl: Interface | null = null;
  #pending = new Map();
  #nextId = 1;
  #initResult: Record<string, unknown> | null = null;
  #authenticated = false;
  #startPromise: Promise<void> | null = null;

  constructor(options: GrokAcpClientOptions = {}) {
    this.#executable = options.executable?.trim() || process.env.GROK_EXECUTABLE?.trim() || "grok";
    this.#onNotification = options.onNotification ?? (() => {});
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  get initResult() {
    return this.#initResult;
  }

  get authenticated() {
    return this.#authenticated;
  }

  get running() {
    return this.#child !== null && !this.#child.killed;
  }

  async ensureReady() {
    if (this.#startPromise) {
      await this.#startPromise;
      return;
    }
    this.#startPromise = this.#start();
    try {
      await this.#startPromise;
    } catch (error) {
      this.#startPromise = null;
      throw error;
    }
  }

  async request(method, params = {}, options = {}) {
    await this.ensureReady();
    return await this.#requestReadyProcess(method, params, options);
  }

  async #requestReadyProcess(method, params = {}, options = {}) {
    if (!this.#child?.stdin) throw new Error("Grok ACP process is not running");
    const timeoutMs =
      typeof options.timeoutMs === "number" ? options.timeoutMs : this.#requestTimeoutMs;
    const id = this.#nextId++;
    return await new Promise((resolve, reject) => {
      let timer;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`Grok ACP request timed out: ${method}`));
        }, timeoutMs);
      }
      this.#pending.set(id, {
        resolve: (result) => {
          if (timer) clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      });
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async authenticate() {
    await this.ensureReady();
    const authMethods = Array.isArray(this.#initResult?.authMethods)
      ? this.#initResult.authMethods
      : [];
    const methodIds = new Set(authMethods.map((entry) => entry?.id).filter(Boolean));
    const methodId = process.env.XAI_API_KEY?.trim()
      ? methodIds.has("xai.api_key")
        ? "xai.api_key"
        : null
      : methodIds.has("cached_token")
        ? "cached_token"
        : methodIds.has("grok.com")
          ? "grok.com"
          : null;
    if (!methodId) {
      throw new Error(
        "Grok Build is not authenticated. Run `grok login` in a terminal or set XAI_API_KEY.",
      );
    }
    await this.request("authenticate", {
      methodId,
      _meta: { headless: true },
    });
    this.#authenticated = true;
  }

  async close() {
    this.#pending.clear();
    this.#rl?.close();
    this.#rl = null;
    if (this.#child && !this.#child.killed) {
      try {
        this.#child.kill();
      } catch {}
    }
    this.#child = null;
    this.#initResult = null;
    this.#authenticated = false;
    this.#startPromise = null;
  }

  async #start() {
    if (this.#child) return;
    const child = spawn(this.#executable, ["--no-auto-update", "agent", "stdio"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.#child = child;
    this.#rl = rl;

    rl.on("line", (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof message?.method === "string") {
        this.#onNotification({ method: message.method, params: message.params });
        return;
      }
      if (typeof message?.id !== "number") return;
      const entry = this.#pending.get(message.id);
      if (!entry) return;
      this.#pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error?.message || `Grok ACP error: ${message.id}`);
        error.code = message.error?.code;
        entry.reject(error);
        return;
      }
      entry.resolve(message.result ?? {});
    });

    child.once("exit", () => {
      for (const entry of this.#pending.values()) {
        entry.reject(new Error("Grok ACP process exited"));
      }
      this.#pending.clear();
      this.#child = null;
      this.#rl = null;
      this.#initResult = null;
      this.#authenticated = false;
      this.#startPromise = null;
    });

    this.#initResult = await this.#requestReadyProcess("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });
  }
}

export async function probeGrokAcpReadiness(options: GrokAcpClientOptions = {}) {
  const client = new GrokAcpClient({ ...options, requestTimeoutMs: 15_000 });
  try {
    await client.ensureReady();
    await client.authenticate();
    return {
      ready: true,
      initResult: client.initResult,
    };
  } catch (error) {
    return {
      ready: false,
      error: error instanceof Error ? error.message : String(error),
      initResult: client.initResult,
    };
  } finally {
    await client.close();
  }
}
