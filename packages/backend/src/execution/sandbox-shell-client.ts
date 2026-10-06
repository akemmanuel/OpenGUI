import { request as httpRequest, type ClientRequestArgs } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ShellToolExecutor } from "@opengui/harness";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_BROKER_TIMEOUT_SECONDS = 30;
const MAX_BROKER_TIMEOUT_SECONDS = 5_000;
/** Grace above the broker-enforced command timeout so a healthy broker always
 * answers first; only a hung broker trips the client deadline. */
const BROKER_TIMEOUT_GRACE_SECONDS = 5;

/**
 * Stable machine reasons for sandbox broker transport/auth failures. These
 * are recorded as ordinary tool failure outputs (never thrown, except
 * cancellation), so the Harness stores a `tool_result` instead of failing
 * the Run, and the model sees a bounded summary. Summaries are static
 * strings: they never carry the broker endpoint, tokens, commands, or
 * customer paths.
 *
 * Only authenticated (401/403) and rejected (4xx) pre-execution responses
 * may claim the command did not run. Every other fault happens after a
 * possible dispatch, so its summary states the uncertainty and tells the
 * reader to check the project before retrying.
 */
export type SandboxBrokerFailureReason =
  | "broker_unreachable"
  | "broker_timeout"
  | "broker_unauthorized"
  | "broker_rejected";

export interface SandboxBrokerFailure {
  status: "error";
  reason: SandboxBrokerFailureReason;
  summary: string;
}

const SUMMARY_UNAUTHORIZED =
  "Sandbox shell broker refused authentication. The command did not run.";
const SUMMARY_REJECTED = "Sandbox shell broker rejected the request. The command did not run.";
const SUMMARY_NOT_DISPATCHED =
  "Sandbox shell broker request was rejected before dispatch. The command did not run.";
const SUMMARY_UNREACHABLE =
  "Sandbox shell broker is unreachable. The command may have run: check the project before retrying.";
const SUMMARY_TIMEOUT =
  "Sandbox shell broker timed out. The command may have completed: check the project before retrying.";

function failure(reason: SandboxBrokerFailureReason, summary: string): SandboxBrokerFailure {
  return { status: "error", reason, summary };
}

/** Internal: endpoint configuration faults never reach the network. */
class BrokerConfigError extends Error {
  constructor() {
    super("Sandbox shell broker endpoint is misconfigured");
  }
}

export type BrokerTransport =
  | { kind: "socket"; socketPath: string; path: string }
  | { kind: "tcp"; secure: boolean; hostname: string; port: number; path: string };

/**
 * Maps an endpoint to its transport. Loopback paths stay Unix sockets;
 * `http:`/`https:` select the matching TLS behavior and default port.
 * Anything else (unknown protocols, embedded userinfo, unparsable values)
 * throws BrokerConfigError so credentials are never sent over the wrong
 * transport and no endpoint text leaks into tool outputs.
 */
export function parseBrokerEndpoint(endpoint: string): BrokerTransport {
  if (endpoint.startsWith("/")) {
    return { kind: "socket", socketPath: endpoint, path: "/v1/execute" };
  }
  let remote: URL;
  try {
    remote = new URL(endpoint);
  } catch {
    throw new BrokerConfigError();
  }
  if (remote.protocol !== "http:" && remote.protocol !== "https:") {
    throw new BrokerConfigError();
  }
  if (remote.username || remote.password) {
    throw new BrokerConfigError();
  }
  const secure = remote.protocol === "https:";
  const port = remote.port ? Number(remote.port) : secure ? 443 : 80;
  if (!remote.hostname || !Number.isFinite(port) || port <= 0) {
    throw new BrokerConfigError();
  }
  return {
    kind: "tcp",
    secure,
    // URL.hostname retains brackets around IPv6 literals; Node's hostname
    // option expects the address itself, without URL delimiters.
    hostname: remote.hostname.startsWith("[") ? remote.hostname.slice(1, -1) : remote.hostname,
    port,
    path: `${remote.pathname}${remote.search}`,
  };
}

/** Mirrors the broker's timeout formula so the deadline outlives a healthy call. */
function effectiveTimeoutSeconds(input: unknown): number {
  const timeout = (input as { timeout?: unknown } | null)?.timeout;
  if (typeof timeout !== "number" || !(timeout > 0)) return DEFAULT_BROKER_TIMEOUT_SECONDS;
  return Math.min(MAX_BROKER_TIMEOUT_SECONDS, timeout);
}

function post(
  endpoint: string,
  token: string | undefined,
  input: unknown,
  body: string,
  signal: AbortSignal,
): Promise<unknown> {
  let transport: BrokerTransport;
  try {
    transport = parseBrokerEndpoint(endpoint);
  } catch {
    return Promise.resolve(failure("broker_rejected", SUMMARY_NOT_DISPATCHED));
  }
  return new Promise<unknown>((resolve, reject) => {
    const deadlineMs = (effectiveTimeoutSeconds(input) + BROKER_TIMEOUT_GRACE_SECONDS) * 1000;
    let req: ReturnType<typeof httpRequest>;
    let settled = false;
    let timedOut = false;
    // Wall-clock deadline: socket inactivity timeouts alone let a drip-feed
    // hang past the broker timeout. Cleared on every settlement path.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resolveOnce = (value: unknown) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      reject(error);
    };
    try {
      const headers: Record<string, string | number> = {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      };
      const options: ClientRequestArgs = {
        method: "POST",
        headers,
        signal,
        ...(transport.kind === "socket"
          ? { socketPath: transport.socketPath, path: transport.path }
          : {
              hostname: transport.hostname,
              port: transport.port,
              path: transport.path,
            }),
      };
      const impl = transport.kind !== "socket" && transport.secure ? httpsRequest : httpRequest;
      req = impl(options, (response) => {
        // Register stream handlers before every status/settlement branch.
        response.on("error", () => {
          if (signal.aborted || settled) return;
          resolveOnce(
            timedOut
              ? failure("broker_timeout", SUMMARY_TIMEOUT)
              : failure("broker_unreachable", SUMMARY_UNREACHABLE),
          );
        });
        response.on("close", () => {
          if (!settled && !response.complete && !signal.aborted) {
            resolveOnce(
              timedOut
                ? failure("broker_timeout", SUMMARY_TIMEOUT)
                : failure("broker_unreachable", SUMMARY_UNREACHABLE),
            );
          }
        });
        if (settled) {
          response.destroy();
          return;
        }
        const status = response.statusCode ?? 500;
        if (status >= 400) {
          resolveOnce(
            status === 401 || status === 403
              ? failure("broker_unauthorized", SUMMARY_UNAUTHORIZED)
              : status < 500
                ? failure("broker_rejected", SUMMARY_REJECTED)
                : failure("broker_unreachable", SUMMARY_UNREACHABLE),
          );
          // The error body is deliberately unused. Do not drain an unbounded
          // stream after settling and clearing its wall-clock deadline.
          response.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        let oversized = false;
        response.on("data", (chunk: Buffer) => {
          if (settled || oversized) return;
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            oversized = true;
            response.destroy();
            // The response is unusable and dispatch already happened, so
            // this is uncertainty, not a pre-execution rejection.
            resolveOnce(failure("broker_unreachable", SUMMARY_UNREACHABLE));
          } else chunks.push(chunk);
        });
        response.on("end", () => {
          if (settled) return;
          try {
            // Ordinary 200 payloads (including nonzero command exits such as
            // docker exit 125) pass through untouched: only the broker may
            // classify execution faults, never this client.
            resolveOnce(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
          } catch {
            resolveOnce(failure("broker_unreachable", SUMMARY_UNREACHABLE));
          }
        });
      });
    } catch {
      resolveOnce(failure("broker_rejected", SUMMARY_NOT_DISPATCHED));
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      req.destroy();
    }, deadlineMs);
    req.on("error", (error) => {
      // Cancellation keeps existing semantics: reject so the Harness aborts
      // the Run instead of recording a failure output.
      if (signal.aborted) {
        rejectOnce(error);
        return;
      }
      if (timedOut) {
        resolveOnce(failure("broker_timeout", SUMMARY_TIMEOUT));
        return;
      }
      resolveOnce(failure("broker_unreachable", SUMMARY_UNREACHABLE));
    });
    try {
      req.end(body);
    } catch {
      resolveOnce(failure("broker_rejected", SUMMARY_NOT_DISPATCHED));
      req.destroy();
    }
  });
}

export function createSandboxShellExecutor(endpoint: string, token?: string): ShellToolExecutor {
  return async (context, input) => {
    return await post(
      endpoint,
      token,
      input,
      JSON.stringify({
        projectDirectory: context.projectDirectory,
        grants: context.executionPolicy.grants ?? [],
        input,
        sessionId: context.sessionId,
        toolCallId: context.toolCallId,
      }),
      context.signal,
    );
  };
}
