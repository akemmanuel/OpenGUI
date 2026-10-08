import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { ToolExecutionContext } from "@opengui/harness";
import {
  createSandboxShellExecutor,
  parseBrokerEndpoint,
  type SandboxBrokerFailure,
} from "./sandbox-shell-client.ts";

const servers: Server[] = [];
const socketDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
  await Promise.all(
    socketDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function context(signal?: AbortSignal): ToolExecutionContext {
  return {
    projectDirectory: "/workspace/site",
    dataDirectory: "/tmp/opengui-test",
    sessionId: "session",
    toolCallId: "call",
    shell: { executable: "/bin/sh", family: "posix" },
    signal: signal ?? new AbortController().signal,
    executionPolicy: {
      restricted: true,
      revision: 4,
      shellAllowed: true,
      grants: [{ root: "/workspace/site", access: "write" }],
      async authorizePath() {
        return { allowed: false };
      },
    },
  };
}

const SECRET_TOKEN = "broker-secret-token-xyz";
const SECRET_COMMAND = "echo customer-s3cret /tmp/customer-plans";

async function startServer(
  handler: (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => void,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return `http://127.0.0.1:${port}/v1/execute`;
}

function isFailure(value: unknown): value is SandboxBrokerFailure {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { status?: unknown }).status === "error" &&
    typeof (value as { reason?: unknown }).reason === "string"
  );
}

describe("sandbox shell client fault classification", () => {
  test("passes ordinary 200 payloads through untouched, including exit 125", async () => {
    const endpoint = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          exitCode: 125,
          output: "docker: image not found",
        }),
      );
    });
    const executor = createSandboxShellExecutor(endpoint);
    const result = (await executor(context(), { command: "legit-command" })) as Record<
      string,
      unknown
    >;
    // No client-side classification: exit 125 is an ordinary command result.
    expect(result).toEqual({ exitCode: 125, output: "docker: image not found" });
    expect(isFailure(result)).toBe(false);
  });

  test("unreachable broker returns broker_unreachable without leaking endpoint or command", async () => {
    // Port 1 is never bound: connection refused.
    const executor = createSandboxShellExecutor("http://127.0.0.1:1/v1/execute", SECRET_TOKEN);
    const result = await executor(context(), { command: SECRET_COMMAND });
    expect(result).toEqual({
      status: "error",
      reason: "broker_unreachable",
      summary: expect.any(String),
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("127.0.0.1");
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain("customer-s3cret");
    expect(serialized).not.toContain("/tmp/customer-plans");
  });

  test(
    "hung broker returns broker_timeout once the socket outlives the requested timeout",
    { timeout: 30_000 },
    async () => {
      const endpoint = await startServer(() => {
        // Never respond.
      });
      const executor = createSandboxShellExecutor(endpoint);
      const started = Date.now();
      const result = await executor(context(), { command: "sleep 60", timeout: 1 });
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(result).toMatchObject({ status: "error", reason: "broker_timeout" });
    },
  );

  test("missing token against a locked broker returns broker_unauthorized", async () => {
    const endpoint = await startServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${SECRET_TOKEN}`) {
        response.writeHead(401, { "content-type": "application/json" }).end("{}");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    const executor = createSandboxShellExecutor(endpoint);
    const result = await executor(context(), { command: "pwd" });
    expect(result).toMatchObject({ status: "error", reason: "broker_unauthorized" });
    expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
  });

  test("wrong token returns broker_unauthorized without echoing either token", async () => {
    const endpoint = await startServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${SECRET_TOKEN}`) {
        response.writeHead(401, { "content-type": "application/json" }).end("{}");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    const executor = createSandboxShellExecutor(endpoint, "wrong-token");
    const result = await executor(context(), { command: "pwd" });
    expect(result).toMatchObject({ status: "error", reason: "broker_unauthorized" });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain("wrong-token");
  });

  test("broker rejection (400) returns broker_rejected", async () => {
    const endpoint = await startServer((_request, response) => {
      response
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ denied: true }));
    });
    const executor = createSandboxShellExecutor(endpoint);
    const result = await executor(context(), { command: "pwd" });
    expect(result).toMatchObject({ status: "error", reason: "broker_rejected" });
  });

  test("broker outage (500) returns broker_unreachable, not a rejection", async () => {
    const endpoint = await startServer((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" }).end("{}");
    });
    const executor = createSandboxShellExecutor(endpoint);
    const result = await executor(context(), { command: "pwd" });
    expect(result).toMatchObject({ status: "error", reason: "broker_unreachable" });
  });

  test("unreadable broker payload returns broker_unreachable", async () => {
    const endpoint = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" }).end("not-json{{{");
    });
    const executor = createSandboxShellExecutor(endpoint);
    const result = await executor(context(), { command: "pwd" });
    expect(result).toMatchObject({ status: "error", reason: "broker_unreachable" });
  });

  test("aborted context rejects so the Harness aborts the Run", async () => {
    const endpoint = await startServer(() => {
      // Never respond; the abort must win.
    });
    const controller = new AbortController();
    const pending = createSandboxShellExecutor(endpoint)(context(controller.signal), {
      command: "sleep 60",
    });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe("sandbox shell client stream and transport hardening", () => {
  test.each([400, 401, 500])(
    "closes an HTTP %s error response without draining an unbounded body",
    async (status) => {
      let closeResponse!: () => void;
      const closed = new Promise<boolean>((resolve) => {
        closeResponse = () => resolve(true);
      });
      const endpoint = await startServer((_request, response) => {
        response.once("close", closeResponse);
        response.writeHead(status).write("unfinished error body");
        // Bound fixture cleanup even when the client does not release its socket.
        setTimeout(() => response.destroy(), 2_000).unref();
      });
      const result = await createSandboxShellExecutor(endpoint)(context(), { command: "pwd" });
      expect(isFailure(result)).toBe(true);
      expect(
        await Promise.race([
          closed,
          new Promise((resolve) => setTimeout(() => resolve(false), 500)),
        ]),
      ).toBe(true);
    },
  );
  test(
    "partial JSON then destroyed connection resolves to a sanitized failure instead of hanging",
    { timeout: 30_000 },
    async () => {
      const endpoint = await startServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"exitCode": 0, "outp');
        setImmediate(() => response.destroy());
      });
      const executor = createSandboxShellExecutor(endpoint);
      const result = await executor(context(), { command: "pwd" });
      expect(result).toMatchObject({ status: "error", reason: "broker_unreachable" });
      expect((result as SandboxBrokerFailure).summary).toMatch(/check the project/i);
      expect((result as SandboxBrokerFailure).summary).not.toMatch(/did not run/i);
    },
  );

  test(
    "drip-feed response trips the wall-clock deadline, not the broker timeout",
    { timeout: 30_000 },
    async () => {
      const endpoint = await startServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        const interval = setInterval(() => {
          if (!response.writableEnded) response.write(" ");
        }, 400);
        response.on("close", () => clearInterval(interval));
      });
      const executor = createSandboxShellExecutor(endpoint);
      const started = Date.now();
      const result = await executor(context(), { command: "slow", timeout: 1 });
      // Wall-clock deadline (1s requested + 5s grace) bounds a stream that
      // never goes idle long enough to matter: well under the ~35s a
      // drip-feed could otherwise consume, and far under broker maximums.
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(result).toMatchObject({ status: "error", reason: "broker_timeout" });
      expect((result as SandboxBrokerFailure).summary).toMatch(/check the project/i);
    },
  );

  test(
    "headers-only hang resolves to broker_timeout at the deadline",
    { timeout: 30_000 },
    async () => {
      const endpoint = await startServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        // No body, no end: the deadline must settle this.
      });
      const executor = createSandboxShellExecutor(endpoint);
      const result = await executor(context(), { command: "slow", timeout: 1 });
      expect(result).toMatchObject({ status: "error", reason: "broker_timeout" });
    },
  );

  test("uncertain faults never claim the command did not run", async () => {
    const refused = createSandboxShellExecutor("http://127.0.0.1:1/v1/execute");
    const refusedResult = (await refused(context(), { command: "pwd" })) as SandboxBrokerFailure;
    expect(refusedResult.reason).toBe("broker_unreachable");
    expect(refusedResult.summary).toMatch(/may have run/i);
    expect(refusedResult.summary).toMatch(/check the project/i);
  });

  test("pre-execution faults keep the explicit did-not-run claim", async () => {
    const locked = await startServer((request, response) => {
      if (request.headers.authorization !== "Bearer token") {
        response.writeHead(401, { "content-type": "application/json" }).end("{}");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    const denied = await createSandboxShellExecutor(locked)(context(), { command: "pwd" });
    expect((denied as SandboxBrokerFailure).summary).toMatch(/did not run/i);
    const rejectedEndpoint = await startServer((_request, response) => {
      response.writeHead(400, { "content-type": "application/json" }).end("{}");
    });
    const rejected = await createSandboxShellExecutor(rejectedEndpoint)(context(), {
      command: "pwd",
    });
    expect((rejected as SandboxBrokerFailure).summary).toMatch(/did not run/i);
  });

  test("oversized responses are uncertainty, not pre-execution rejections", async () => {
    const endpoint = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write(`{"exitCode":0,"output":"${"x".repeat(2 * 1024 * 1024)}"}`);
      response.end();
    });
    const executor = createSandboxShellExecutor(endpoint);
    const result = (await executor(context(), { command: "huge" })) as SandboxBrokerFailure;
    expect(result.reason).toBe("broker_unreachable");
    expect(result.summary).toMatch(/check the project/i);
    expect(result.summary).not.toMatch(/did not run/i);
  });

  test("https endpoint against a plaintext server fails closed and sanitized", async () => {
    const plain = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    const httpsEndpoint = plain.replace("http://", "https://");
    const executor = createSandboxShellExecutor(httpsEndpoint, SECRET_TOKEN);
    const result = (await executor(context(), { command: "pwd" })) as SandboxBrokerFailure;
    // TLS handshake against plaintext fails: must not fall back, hang, or leak.
    expect(result.reason).toBe("broker_unreachable");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("127.0.0.1");
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain(plain);
  });

  test("endpoint userinfo is refused before dispatch with zero server hits", async () => {
    let hits = 0;
    const endpoint = await startServer((_request, response) => {
      hits += 1;
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    const userinfoEndpoint = endpoint.replace("http://", "http://user:s3cret@");
    const result = (await createSandboxShellExecutor(userinfoEndpoint, SECRET_TOKEN)(context(), {
      command: "pwd",
    })) as SandboxBrokerFailure;
    expect(result).toMatchObject({ status: "error", reason: "broker_rejected" });
    expect(result.summary).toMatch(/did not run/i);
    expect(hits).toBe(0);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("user");
    expect(serialized).not.toContain("s3cret");
    expect(serialized).not.toContain(SECRET_TOKEN);
  });

  test("unexpected protocol never touches the network", async () => {
    const result = (await createSandboxShellExecutor("ftp://127.0.0.1:21/v1/execute")(context(), {
      command: "pwd",
    })) as SandboxBrokerFailure;
    expect(result).toMatchObject({ status: "error", reason: "broker_rejected" });
    expect(result.summary).toMatch(/did not run/i);
  });

  test("malformed endpoint becomes a sanitized rejection, not a throw", async () => {
    const result = (await createSandboxShellExecutor("notaurl jarvis")(context(), {
      command: "pwd",
    })) as SandboxBrokerFailure;
    expect(result).toMatchObject({ status: "error", reason: "broker_rejected" });
    expect(JSON.stringify(result)).not.toContain("notaurl");
  });

  test("unix socket endpoints keep working end to end", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opengui-sock-"));
    socketDirectories.push(directory);
    const socketPath = join(directory, "broker.sock");
    const server = createServer((_request, response) => {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ exitCode: 0, output: "socket-ok" }));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    servers.push(server);
    const result = await createSandboxShellExecutor(socketPath)(context(), { command: "pwd" });
    expect(result).toEqual({ exitCode: 0, output: "socket-ok" });
  });
});

describe("parseBrokerEndpoint", () => {
  test("maps http/https defaults and explicit ports, preserving paths", () => {
    expect(parseBrokerEndpoint("http://broker:8080/v1/execute")).toEqual({
      kind: "tcp",
      secure: false,
      hostname: "broker",
      port: 8080,
      path: "/v1/execute",
    });
    expect(parseBrokerEndpoint("http://broker/v1/execute")).toMatchObject({
      secure: false,
      port: 80,
    });
    expect(parseBrokerEndpoint("https://broker/v1/execute")).toMatchObject({
      secure: true,
      port: 443,
    });
    expect(parseBrokerEndpoint("https://broker:8443/v1/execute?x=1")).toMatchObject({
      secure: true,
      port: 8443,
      path: "/v1/execute?x=1",
    });
    expect(parseBrokerEndpoint("/run/broker.sock")).toEqual({
      kind: "socket",
      socketPath: "/run/broker.sock",
      path: "/v1/execute",
    });
  });

  test("passes IPv6 literals without URL brackets to the Node transport", () => {
    expect(parseBrokerEndpoint("https://[::1]:8443/v1/execute")).toMatchObject({
      hostname: "::1",
      port: 8443,
      secure: true,
    });
  });

  test("rejects userinfo, unknown protocols, and unparsable values", () => {
    for (const endpoint of [
      "http://user:pass@broker/v1/execute",
      "http://user@broker/v1/execute",
      "ftp://broker/v1/execute",
      "gopher://broker/v1/execute",
      "notaurl",
      "http://",
    ]) {
      expect(() => parseBrokerEndpoint(endpoint)).toThrow();
    }
  });
});
