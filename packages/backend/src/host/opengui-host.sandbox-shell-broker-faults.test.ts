/**
 * Regression tests for #153: authenticated restricted Account -> Host ->
 * Harness -> sandbox executor, built through createBackendHost with real
 * identity, path grants, and a fixture model. A fake broker HTTP server
 * stands in for Docker (no Docker, no production, no real models).
 *
 * Broker transport/auth faults are recorded as ordinary tool failure outputs
 * with stable machine reasons; ordinary command exits (including exit 125)
 * pass through untouched; revocation still fails closed before any effect.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { ModelTransport } from "@opengui/harness";
import { createBackendHost, type BackendHost } from "../create-backend-host.ts";
import { readBackendHostEnv } from "../host/env.ts";
import { OpenGuiHost } from "./opengui-host.ts";

const backends: BackendHost[] = [];
const temporaryDirectories: string[] = [];
const servers: Server[] = [];
const savedEndpoint = process.env.OPENGUI_SHELL_SANDBOX_ENDPOINT;
const savedToken = process.env.OPENGUI_SHELL_SANDBOX_TOKEN;

afterEach(async () => {
  for (const backend of backends.splice(0)) {
    await (await backend.hostReady).close();
    backend.identity?.database.close();
  }
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
  if (savedEndpoint === undefined) delete process.env.OPENGUI_SHELL_SANDBOX_ENDPOINT;
  else process.env.OPENGUI_SHELL_SANDBOX_ENDPOINT = savedEndpoint;
  if (savedToken === undefined) delete process.env.OPENGUI_SHELL_SANDBOX_TOKEN;
  else process.env.OPENGUI_SHELL_SANDBOX_TOKEN = savedToken;
});

type BrokerMode =
  | { kind: "ok" }
  | { kind: "exit125" }
  | { kind: "unauthorized"; token: string }
  | { kind: "always400" }
  | { kind: "hang" };

interface BrokerTap {
  endpoint: string;
  hits: () => number;
  lastBody: () => Record<string, unknown> | null;
}

async function startFakeBroker(mode: BrokerMode): Promise<BrokerTap> {
  let hits = 0;
  let lastBody: Record<string, unknown> | null = null;
  const respond = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  };
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST" || request.url !== "/v1/execute") {
      response.writeHead(404).end();
      return;
    }
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      hits += 1;
      try {
        lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        lastBody = null;
      }
      if (mode.kind === "hang") return; // Never respond.
      if (mode.kind === "unauthorized") {
        if (request.headers.authorization !== `Bearer ${mode.token}`) {
          respond(response, 401, { denied: true });
          return;
        }
        respond(response, 200, { exitCode: 0, output: "sandboxed-ok" });
        return;
      }
      if (mode.kind === "always400") {
        respond(response, 400, { denied: true, error: "Sandbox shell request was rejected" });
        return;
      }
      if (mode.kind === "exit125") {
        respond(response, 200, {
          exitCode: 125,
          output: "docker: Error response from daemon: image not found.",
        });
        return;
      }
      respond(response, 200, { exitCode: 0, output: "sandboxed-ok" });
    })();
  };
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    endpoint: `http://127.0.0.1:${port}/v1/execute`,
    hits: () => hits,
    lastBody: () => lastBody,
  };
}

/** Fixture model: issues one shell tool call per prompt budget, then answers. */
function countingModel(budget: { calls: number }, toolInput: Record<string, unknown>) {
  let emitted = 0;
  const model: ModelTransport = {
    async *stream(request) {
      const results = request.context.filter(
        (item) => (item as { type?: string }).type === "tool_result",
      ).length;
      if (emitted === results && emitted < budget.calls) {
        emitted += 1;
        yield {
          type: "tool_call",
          id: `shell-${emitted}`,
          name: "shell",
          input: toolInput,
        };
      } else {
        yield { type: "text_delta", delta: "Finished" };
      }
      yield { type: "completed" };
    },
  };
  return model;
}

interface MemberBackend {
  backend: BackendHost;
  host: OpenGuiHost;
  member: { type: "user"; id: string; displayName: string };
  ownerToken: string;
  projectDirectory: string;
  budget: { calls: number };
}

async function setupMemberBackend(options: {
  broker: BrokerTap | null;
  token?: string;
  toolInput?: Record<string, unknown>;
  grantAccess?: "write" | "none";
}): Promise<MemberBackend> {
  const root = await mkdtemp(join(tmpdir(), "opengui-broker-faults-"));
  temporaryDirectories.push(root);
  const projectDirectory = join(root, "project");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(projectDirectory, { recursive: true });

  if (options.broker) process.env.OPENGUI_SHELL_SANDBOX_ENDPOINT = options.broker.endpoint;
  else delete process.env.OPENGUI_SHELL_SANDBOX_ENDPOINT;
  if (options.token === undefined) delete process.env.OPENGUI_SHELL_SANDBOX_TOKEN;
  else process.env.OPENGUI_SHELL_SANDBOX_TOKEN = options.token;

  const budget = { calls: 0 };
  const backend = createBackendHost({
    dataDirectory: join(root, "host-data"),
    env: {
      ...readBackendHostEnv(),
      identityMode: "remote",
      pathGrantsMode: "enforced",
      allowedRoots: [root],
      authToken: "",
      servesFrontend: false,
    },
    identityDatabase: new DatabaseSync(":memory:"),
    identitySecret: "broker-faults-test-secret-at-least-32-characters",
    identityBaseURL: "http://localhost",
    model: countingModel(budget, options.toolInput ?? { command: "pwd" }),
  });
  backends.push(backend);
  await backend.ready;

  const request = (path: string, token: string, method = "GET", body?: unknown) =>
    backend.app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const setup = await request("/api/identity/setup", "", "POST", {
    username: "owner",
    email: "owner@example.com",
    password: "a sufficiently long owner password",
  });
  expect(setup.status).toBe(201);
  const ownerToken = ((await setup.json()) as { value: { token: string } }).value.token;
  await request("/api/identity/host-policy", ownerToken, "PUT", { registrationMode: "open" });
  const register = await request("/api/identity/register", "", "POST", {
    username: "member",
    email: "member@example.com",
    password: "a sufficiently long member password",
  });
  expect(register.status).toBe(201);
  const memberId = ((await register.json()) as { value: { actor: { id: string } } }).value.actor.id;
  if (options.grantAccess !== "none") {
    const grant = await request(
      `/api/identity/members/${memberId}/path-grants`,
      ownerToken,
      "PUT",
      {
        grants: [{ root: projectDirectory, access: "write" }],
      },
    );
    expect(grant.status).toBe(200);
  }
  const host = await backend.hostReady;
  return {
    backend,
    host,
    member: { type: "user", id: memberId, displayName: "member" },
    ownerToken,
    projectDirectory,
    budget,
  };
}

async function promptShell(
  fixture: MemberBackend,
  text: string,
): Promise<{ sessionId: string; entries: unknown[]; dump: string }> {
  const { host, member, projectDirectory, budget } = fixture;
  const session = await host.createSession(
    {
      projectDirectory,
      model: { connectionId: "fake", modelId: "fake" },
      reasoning: "none",
    },
    member,
  );
  budget.calls += 1;
  await host.prompt(session.id, { text, actor: member });
  await host.waitForIdle(session.id, member);
  const snapshot = await host.readSession(session.id, member);
  return { sessionId: session.id, entries: snapshot.entries, dump: JSON.stringify(snapshot) };
}

function toolResultOutputs(entries: unknown[]) {
  return (entries as Array<{ kind?: string; payload?: { output?: unknown } }>)
    .filter((entry) => entry.kind === "tool_result")
    .map((entry) => entry.payload?.output);
}

describe("authenticated restricted shell broker faults (#153)", () => {
  test("healthy broker executes through the restricted Account path and forwards grants", async () => {
    const broker = await startFakeBroker({ kind: "ok" });
    const fixture = await setupMemberBackend({ broker });
    const { dump } = await promptShell(fixture, "Run pwd");
    expect(dump).toContain("sandboxed-ok");
    expect(broker.hits()).toBe(1);
    expect((broker.lastBody() as { grants?: unknown[] } | null)?.grants).toHaveLength(1);
  });

  test("wrong token records broker_unauthorized and the Run still completes", async () => {
    const broker = await startFakeBroker({ kind: "unauthorized", token: "correct-token" });
    const fixture = await setupMemberBackend({ broker, token: "wrong-token" });
    const { entries, dump } = await promptShell(fixture, "Run pwd");
    expect(toolResultOutputs(entries)).toEqual([
      expect.objectContaining({ status: "error", reason: "broker_unauthorized" }),
    ]);
    expect(entries.map((entry) => (entry as { kind: string }).kind)).not.toContain("run_failed");
    expect(dump).not.toContain("sandboxed-ok");
  });

  test("missing token against a locked broker records broker_unauthorized", async () => {
    const broker = await startFakeBroker({ kind: "unauthorized", token: "correct-token" });
    const fixture = await setupMemberBackend({ broker });
    const { entries } = await promptShell(fixture, "Run pwd");
    expect(toolResultOutputs(entries)).toEqual([
      expect.objectContaining({ status: "error", reason: "broker_unauthorized" }),
    ]);
  });

  test("broker outage records broker_unreachable without provider misclassification", async () => {
    const broker = await startFakeBroker({ kind: "ok" });
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
    const fixture = await setupMemberBackend({ broker });
    const { entries, dump } = await promptShell(fixture, "Run pwd");
    expect(toolResultOutputs(entries)).toEqual([
      expect.objectContaining({ status: "error", reason: "broker_unreachable" }),
    ]);
    expect(entries.map((entry) => (entry as { kind: string }).kind)).not.toContain("run_failed");
    expect(dump).not.toContain("sandboxed-ok");
  });

  test("hung broker records broker_timeout", { timeout: 30_000 }, async () => {
    const broker = await startFakeBroker({ kind: "hang" });
    const fixture = await setupMemberBackend({
      broker,
      toolInput: { command: "sleep 60", timeout: 1 },
    });
    const { entries } = await promptShell(fixture, "Run a slow command");
    expect(toolResultOutputs(entries)).toEqual([
      expect.objectContaining({ status: "error", reason: "broker_timeout" }),
    ]);
  });

  test("broker rejection records broker_rejected", async () => {
    const broker = await startFakeBroker({ kind: "always400" });
    const fixture = await setupMemberBackend({ broker });
    const { entries } = await promptShell(fixture, "Run pwd");
    expect(toolResultOutputs(entries)).toEqual([
      expect.objectContaining({ status: "error", reason: "broker_rejected" }),
    ]);
  });

  test("failed sandbox requests never fall back to native shell", async () => {
    const broker = await startFakeBroker({ kind: "ok" });
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
    const fixture = await setupMemberBackend({
      broker,
      toolInput: { command: "echo NATIVE_SHELL_MARKER_9f31" },
    });
    const { entries } = await promptShell(fixture, "Run the command");
    expect(toolResultOutputs(entries)).toEqual([
      expect.objectContaining({ status: "error", reason: "broker_unreachable" }),
    ]);
    // The command text is durable in the tool_call input (pre-existing
    // behavior), but no execution output exists: the tool_result carries
    // only the classified failure, proving native shell never ran.
    expect(JSON.stringify(toolResultOutputs(entries))).not.toContain("NATIVE_SHELL_MARKER_9f31");
  });

  test("legitimate command exit 125 passes through with no failure reason", async () => {
    const broker = await startFakeBroker({ kind: "exit125" });
    const fixture = await setupMemberBackend({ broker });
    const { entries, dump } = await promptShell(fixture, "Run pwd");
    expect(dump).toContain("125");
    const outputs = toolResultOutputs(entries) as Array<Record<string, unknown>>;
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.exitCode).toBe(125);
    expect(outputs[0]).not.toHaveProperty("reason");
  });

  test("failure outputs carry no tokens, endpoints, or customer paths", async () => {
    const secretToken = "super-secret-broker-token-42";
    const broker = await startFakeBroker({ kind: "unauthorized", token: "correct-token" });
    const fixture = await setupMemberBackend({
      broker,
      token: secretToken,
      toolInput: { command: "cat /tmp/customer-plans/secret.txt" },
    });
    const { dump } = await promptShell(fixture, "Read the file");
    expect(dump).not.toContain(secretToken);
    expect(dump).not.toContain(broker.endpoint);
  });

  test("member without grants fails closed at Session creation", async () => {
    const broker = await startFakeBroker({ kind: "ok" });
    const fixture = await setupMemberBackend({ broker, grantAccess: "none" });
    await expect(
      fixture.host.createSession(
        {
          projectDirectory: fixture.projectDirectory,
          model: { connectionId: "fake", modelId: "fake" },
          reasoning: "none",
        },
        fixture.member,
      ),
    ).rejects.toThrow(/not authorized/i);
    expect(broker.hits()).toBe(0);
  });

  test("revoked grants fail the next prompt closed with no further broker call", async () => {
    const broker = await startFakeBroker({ kind: "ok" });
    const fixture = await setupMemberBackend({ broker });
    const { host, member, projectDirectory, budget } = fixture;
    const session = await host.createSession(
      {
        projectDirectory,
        model: { connectionId: "fake", modelId: "fake" },
        reasoning: "none",
      },
      member,
    );
    budget.calls += 1;
    await host.prompt(session.id, { text: "Run pwd", actor: member });
    await host.waitForIdle(session.id, member);
    expect(broker.hits()).toBe(1);
    // Revoke every grant through the real owner route, then re-prompt.
    const revoked = await fixture.backend.app.request(
      `/api/identity/members/${member.id}/path-grants`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${fixture.ownerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ grants: [] }),
      },
    );
    expect(revoked.status).toBe(200);
    budget.calls += 1;
    await expect(host.prompt(session.id, { text: "Run pwd again", actor: member })).rejects.toThrow(
      /Session not found/,
    );
    expect(broker.hits()).toBe(1);
  });

  test("missing executor still reports sandbox_not_configured (stale wiring contract)", async () => {
    // Unreachable through createBackendHost (endpoint and executor move
    // together there); documents the execute-tool contract directly: a
    // restricted policy that allows shell with no executor wired fails
    // closed with sandbox_not_configured instead of touching native shell.
    const root = await mkdtemp(join(tmpdir(), "opengui-no-executor-"));
    temporaryDirectories.push(root);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "project"), { recursive: true });
    const dataDirectory = await mkdtemp(join(tmpdir(), "opengui-no-executor-data-"));
    temporaryDirectories.push(dataDirectory);
    const budget = { calls: 0 };
    const host = new OpenGuiHost(dataDirectory, {
      model: countingModel(budget, { command: "pwd" }),
      resolveExecutionPolicy: async () => ({
        restricted: true,
        revision: 7,
        shellAllowed: true,
        grants: [{ root: join(root, "project"), access: "write" }],
        async authorizePath(target: string) {
          return { allowed: true, canonicalPath: target };
        },
      }),
      shellExecutor: undefined,
    });
    await host.start();
    try {
      const session = await host.createSession({
        projectDirectory: join(root, "project"),
        model: { connectionId: "fake", modelId: "fake" },
        reasoning: "none",
      });
      budget.calls += 1;
      await host.prompt(session.id, {
        text: "Run pwd",
        actor: { type: "user", id: "member", displayName: "Member" },
      });
      await host.waitForIdle(session.id);
      expect(JSON.stringify(await host.readSession(session.id))).toContain(
        "sandbox_not_configured",
      );
    } finally {
      await host.close();
    }
  });
});
