import { request as httpRequest, type ClientRequestArgs } from "node:http";
import { request as httpsRequest } from "node:https";
import { runAbortable, type ShellToolExecutor } from "@opengui/harness";
import { Duration, Effect, Schedule, Schema } from "effect";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_BROKER_TIMEOUT_SECONDS = 30;
const MAX_BROKER_TIMEOUT_SECONDS = 900;
/** Grace above the broker-enforced command timeout so a healthy broker always
 * answers first; only a hung broker trips the client deadline. Covers the
 * broker's bounded (15s) container removal after a command timeout. */
const BROKER_TIMEOUT_GRACE_SECONDS = 20;

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
  | "broker_busy"
  | "broker_rejected";

export interface SandboxBrokerFailure {
  status: "error";
  reason: SandboxBrokerFailureReason;
  summary: string;
}

const SUMMARY_UNAUTHORIZED =
  "Sandbox shell broker refused authentication. The command did not run.";
const SUMMARY_REJECTED = "Sandbox shell broker rejected the request. The command did not run.";
const SUMMARY_BUSY =
  "Sandbox shell broker is busy with other commands. The command did not run. Retry shortly; reloading or starting a new chat will not free capacity.";
const SUMMARY_NOT_DISPATCHED =
  "Sandbox shell broker request was rejected before dispatch. The command did not run.";
const SUMMARY_UNREACHABLE =
  "Sandbox shell broker is unreachable. The command may have run: check the project before retrying.";
const SUMMARY_TIMEOUT =
  "Sandbox shell broker timed out. The command may have completed: check the project before retrying.";

function failure(reason: SandboxBrokerFailureReason, summary: string): SandboxBrokerFailure {
  return { status: "error", reason, summary };
}

/** Typed broker fault; converted to a {@link SandboxBrokerFailure} tool output at the boundary. */
export class SandboxBrokerError extends Schema.TaggedError<SandboxBrokerError>()(
  "SandboxBrokerError",
  {
    reason: Schema.Literals([
      "broker_unreachable",
      "broker_timeout",
      "broker_unauthorized",
      "broker_busy",
      "broker_rejected",
    ]),
    summary: Schema.String,
  },
) {}

const brokerError = (reason: SandboxBrokerFailureReason, summary: string) =>
  new SandboxBrokerError({ reason, summary });

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

function statusError(status: number) {
  return status === 429
    ? brokerError("broker_busy", SUMMARY_BUSY)
    : status === 401 || status === 403
      ? brokerError("broker_unauthorized", SUMMARY_UNAUTHORIZED)
      : status < 500
        ? brokerError("broker_rejected", SUMMARY_REJECTED)
        : brokerError("broker_unreachable", SUMMARY_UNREACHABLE);
}

/**
 * One broker round trip. Interruption (cancellation or the wall-clock
 * deadline) destroys the request, so no socket outlives the call.
 */
function sendRequest(transport: BrokerTransport, token: string | undefined, body: string) {
  return Effect.callback<unknown, SandboxBrokerError>((resume) => {
    let settled = false;
    const succeed = (value: unknown) => {
      if (settled) return;
      settled = true;
      resume(Effect.succeed(value));
    };
    const fail = (error: SandboxBrokerError) => {
      if (settled) return;
      settled = true;
      resume(Effect.fail(error));
    };
    const unreachable = () => fail(brokerError("broker_unreachable", SUMMARY_UNREACHABLE));
    let req: ReturnType<typeof httpRequest>;
    try {
      const options: ClientRequestArgs = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(transport.kind === "socket"
          ? { socketPath: transport.socketPath, path: transport.path }
          : { hostname: transport.hostname, port: transport.port, path: transport.path }),
      };
      const impl = transport.kind !== "socket" && transport.secure ? httpsRequest : httpRequest;
      req = impl(options, (response) => {
        // Register stream handlers before every status/settlement branch.
        response.on("error", unreachable);
        response.on("close", () => {
          if (!response.complete) unreachable();
        });
        if (settled) {
          response.destroy();
          return;
        }
        const status = response.statusCode ?? 500;
        if (status >= 400) {
          fail(statusError(status));
          // The error body is deliberately unused. Do not drain an unbounded
          // stream after settling.
          response.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            // The response is unusable and dispatch already happened, so
            // this is uncertainty, not a pre-execution rejection.
            unreachable();
            response.destroy();
          } else chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            // Ordinary 200 payloads (including nonzero command exits such as
            // docker exit 125) pass through untouched: only the broker may
            // classify execution faults, never this client.
            succeed(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
          } catch {
            unreachable();
          }
        });
      });
      req.on("error", unreachable);
      req.end(body);
    } catch {
      fail(brokerError("broker_rejected", SUMMARY_NOT_DISPATCHED));
      return;
    }
    return Effect.sync(() => {
      settled = true;
      req.destroy();
    });
  });
}

/**
 * Executes one command. The wall-clock deadline also covers drip-fed
 * responses that socket inactivity timeouts would let hang.
 */
const execute = Effect.fnUntraced(function* (
  endpoint: string,
  token: string | undefined,
  input: unknown,
  body: string,
  graceSeconds: number,
) {
  const transport = yield* Effect.try({
    try: () => parseBrokerEndpoint(endpoint),
    catch: () => brokerError("broker_rejected", SUMMARY_NOT_DISPATCHED),
  });
  return yield* sendRequest(transport, token, body).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(effectiveTimeoutSeconds(input) + graceSeconds),
      orElse: () => Effect.fail(brokerError("broker_timeout", SUMMARY_TIMEOUT)),
    }),
  );
});

export function createSandboxShellExecutor(
  endpoint: string,
  token?: string,
  options: { busyWaitMs?: number; timeoutGraceSeconds?: number } = {},
): ShellToolExecutor {
  const busyWaitMs = options.busyWaitMs ?? 20_000;
  const graceSeconds = options.timeoutGraceSeconds ?? BROKER_TIMEOUT_GRACE_SECONDS;
  if (!Number.isFinite(busyWaitMs) || busyWaitMs < 0 || busyWaitMs > 20_000)
    throw new Error("Invalid broker busy wait");
  // Only a pre-execution 429 is safe to retry. Never replay a command after
  // an uncertain transport failure or an ordinary nonzero command exit.
  const busyRetry = Schedule.max([Schedule.spaced("250 millis"), Schedule.during(busyWaitMs)]);
  return (context, input) => {
    const body = JSON.stringify({
      projectDirectory: context.projectDirectory,
      grants: context.executionPolicy.grants ?? [],
      input,
      sessionId: context.sessionId,
      toolCallId: context.toolCallId,
    });
    // Failures become ordinary tool outputs; cancellation interrupts the
    // request and rejects so the Harness aborts the Run.
    return runAbortable(
      execute(endpoint, token, input, body, graceSeconds).pipe(
        Effect.retry({ while: (error) => error.reason === "broker_busy", schedule: busyRetry }),
        Effect.catchTag("SandboxBrokerError", (error) =>
          Effect.succeed(failure(error.reason, error.summary)),
        ),
      ),
      context.signal,
    );
  };
}
