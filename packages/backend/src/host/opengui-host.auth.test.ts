import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { CODEX_DIAGNOSTICS_FILENAME, HOST_STATE_FILENAME, OpenGuiHost } from "./opengui-host.ts";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function directory() {
  const value = await mkdtemp(join(tmpdir(), "opengui-auth-test-"));
  directories.push(value);
  return value;
}

describe("OpenGuiHost authentication persistence", () => {
  test("keeps durable provider continuation state out of snapshots and events", async () => {
    const dataDirectory = await directory();
    const host = new OpenGuiHost(dataDirectory, {
      model: {
        async *stream(request) {
          yield { type: "text_delta" as const, delta: "ok" };
          yield {
            type: "completed" as const,
            response: {
              responseId: "response-public",
              provider: "fixture",
              api: "openai-responses",
              model: "fixture-model",
              protocol: "openai-responses" as const,
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
              stopReason: "stop" as const,
              replay: { items: [{ type: "reasoning" as const, encryptedContent: "opaque-body" }] },
              cache: {
                key: "private-cache-affinity",
                generation: request.cache?.generation ?? "legacy",
                readTokens: 0,
                writeTokens: 0,
              },
              timing: { startedAt: new Date(0).toISOString(), completedMs: 1, attempts: 1 },
              diagnostics: [{ code: "safe-code", message: "provider raw body" }],
            },
          };
        },
      },
    });
    await host.start();
    const session = await host.createSession({
      projectDirectory: dataDirectory,
      model: { connectionId: "fixture", modelId: "fixture-model" },
      reasoning: "none",
    });
    const events: unknown[] = [];
    const unsubscribe = await host.subscribe(undefined, session.id, (event) => {
      events.push(event);
    });
    await host.prompt(session.id, { text: "hello" });
    await host.waitForIdle(session.id);

    const serializedSnapshot = JSON.stringify(await host.readSession(session.id));
    const serializedEvents = JSON.stringify(events);
    for (const serialized of [serializedSnapshot, serializedEvents]) {
      expect(serialized).not.toMatch(/opaque-body|private-cache-affinity|provider raw body/);
      expect(serialized).toContain("safe-code");
    }
    unsubscribe();
    await host.close();
  });

  test("routes Codex OAuth through pi-ai SSE and refreshes a rejected token exactly once", async () => {
    const dataDirectory = await directory();
    const token = (accountId: string, label: string) => {
      const payload = Buffer.from(
        JSON.stringify({
          label,
          "https://api.openai.com/auth": { chatgpt_account_id: accountId },
        }),
      ).toString("base64url");
      return `header.${payload}.signature`;
    };
    await writeFile(
      join(dataDirectory, "opengui-host-secrets.json"),
      JSON.stringify({
        codex: {
          accessToken: token("account-old", "old"),
          refreshToken: "refresh-old",
          expiresAt: Date.now() + 3_600_000,
          accountId: "account-old",
        },
      }),
      { mode: 0o600 },
    );
    const authorizations: string[] = [];
    let refreshes = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (url === "https://auth.openai.com/oauth/token") {
        refreshes += 1;
        return Response.json({
          id_token: token("account-new", "id"),
          access_token: token("account-new", "new"),
          refresh_token: "refresh-rotated",
          expires_in: 3600,
        });
      }
      expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
      const headers = new Headers(init?.headers);
      authorizations.push(headers.get("authorization") ?? "");
      if (authorizations.length === 1) return new Response("rejected", { status: 401 });
      expect(headers.get("chatgpt-account-id")).toBe("account-new");
      expect(headers.get("originator")).toBe("opengui");
      expect(headers.get("user-agent")).toBe("OpenGUI/1.0");
      return new Response(
        'data: {"type":"response.output_item.added","item":{"type":"message","id":"msg_1","role":"assistant","status":"in_progress","content":[]}}\n\n' +
          'data: {"type":"response.content_part.added","part":{"type":"output_text","text":""}}\n\n' +
          'data: {"type":"response.output_text.delta","delta":"codex ok"}\n\n' +
          'data: {"type":"response.output_item.done","item":{"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"codex ok"}]}}\n\n' +
          'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":9,"output_tokens":2,"total_tokens":11,"input_tokens_details":{"cached_tokens":4}}}}\n\n',
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const host = new OpenGuiHost(dataDirectory, {
      codexPiTransport: "sse",
      ownerModelDiagnostics: true,
    });
    await host.start();
    const session = await host.createSession({
      projectDirectory: dataDirectory,
      model: { connectionId: "chatgpt-codex", modelId: "gpt-5.4" },
      reasoning: "high",
    });
    await host.prompt(session.id, { text: "hello" });
    await host.waitForIdle(session.id);

    expect(refreshes).toBe(1);
    expect(authorizations).toEqual([
      `Bearer ${token("account-old", "old")}`,
      `Bearer ${token("account-new", "new")}`,
    ]);
    const snapshot = await host.readSession(session.id);
    expect(snapshot.entries).toContainEqual(
      expect.objectContaining({
        kind: "provider_response",
        payload: expect.objectContaining({
          response: expect.objectContaining({
            responseId: "resp_1",
            api: "openai-codex-responses",
            protocol: "codex-responses",
            usage: expect.objectContaining({ cacheRead: 4 }),
            timing: expect.objectContaining({ attempts: 2 }),
          }),
        }),
      }),
    );
    expect(
      JSON.parse(await readFile(join(dataDirectory, HOST_STATE_FILENAME), "utf8")),
    ).toMatchObject({
      secrets: { codexTokens: { refreshToken: "refresh-rotated", accountId: "account-new" } },
    });
    const diagnosticsPath = join(dataDirectory, CODEX_DIAGNOSTICS_FILENAME);
    const diagnostics = await readFile(diagnosticsPath, "utf8");
    expect((await stat(diagnosticsPath)).mode & 0o777).toBe(0o600);
    expect(diagnostics).toContain('"attempts":2');
    expect(diagnostics).not.toMatch(/refresh-rotated|account-new|signature/);
    await host.close();
    vi.unstubAllGlobals();
  });

  test("routes documented xAI API-key Responses and completes a reasoning/tool round trip", async () => {
    const dataDirectory = await directory();
    await writeFile(join(dataDirectory, "fixture.txt"), "fixture contents");
    const requests: Array<{ url: string; authorization: string; body: string }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: input instanceof Request ? input.url : input instanceof URL ? input.href : input,
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        body: typeof init?.body === "string" ? init.body : "",
      });
      const wire =
        requests.length === 1
          ? [
              {
                type: "response.reasoning_summary_text.delta",
                delta: "I will read the fixture.",
              },
              {
                type: "response.output_item.done",
                output_index: 0,
                item: {
                  id: "item-read",
                  type: "function_call",
                  call_id: "call-read",
                  name: "read",
                  arguments: JSON.stringify({ path: join(dataDirectory, "fixture.txt") }),
                },
              },
              { type: "response.completed", response: { output: [] } },
            ]
          : [
              { type: "response.output_text.delta", delta: "The fixture is readable." },
              { type: "response.completed", response: { output: [] } },
            ];
      return new Response(wire.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    });
    const host = new OpenGuiHost(dataDirectory, { fetchImpl: fetchImpl as typeof fetch });
    await host.start();
    expect(host.listModelConnections()).toEqual([]);
    await expect(
      host.upsertModelConnection({
        id: "xai-api",
        label: "xAI API",
        baseUrl: "https://api.x.ai/v1",
        modelIds: ["grok-build-0.1"],
      }),
    ).rejects.toThrow("API key is required");
    await host.upsertModelConnection({
      id: "xai-api",
      label: "ignored",
      baseUrl: "https://wrong.invalid",
      modelIds: ["wrong-model"],
      apiKey: "xai-api-secret",
    });
    const session = await host.createSession({
      projectDirectory: dataDirectory,
      model: { connectionId: "xai-api", modelId: "grok-build-0.1" },
      reasoning: "medium",
    });
    await host.prompt(session.id, { text: "Read fixture.txt" });
    await host.waitForIdle(session.id);

    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.url === "https://api.x.ai/v1/responses")).toBe(true);
    expect(requests.every((request) => request.authorization === "Bearer xai-api-secret")).toBe(
      true,
    );
    expect(requests[0]?.body).toContain('"model":"grok-build-0.1"');
    const entries = (await host.readSession(session.id)).entries;
    expect(entries.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        "assistant_reasoning",
        "tool_call",
        "tool_result",
        "assistant_message",
        "run_completed",
      ]),
    );
    expect(JSON.stringify(entries)).toContain("The fixture is readable.");
    await host.close();
  });

  test("refreshes once after a SuperGrok proxy 401 and persists the rotated refresh token", async () => {
    const dataDirectory = await directory();
    await writeFile(
      join(dataDirectory, "opengui-host-secrets.json"),
      JSON.stringify({
        subscriptions: {
          xai: {
            accessToken: "old-access",
            refreshToken: "old-refresh",
            expiresAt: Date.now() + 3_600_000,
          },
        },
      }),
      { mode: 0o600 },
    );
    const authorizations: string[] = [];
    let refreshes = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (url === "https://auth.x.ai/oauth2/token") {
        refreshes += 1;
        return Response.json({
          access_token: "new-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        });
      }
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      if (authorizations.length === 1) return new Response(null, { status: 401 });
      return new Response(
        'data: {"type":"response.output_text.delta","delta":"proxy ok"}\n\n' +
          'data: {"type":"response.completed","response":{"output":[]}}\n\n',
      );
    });
    const host = new OpenGuiHost(dataDirectory, { fetchImpl: fetchImpl as typeof fetch });
    await host.start();
    const session = await host.createSession({
      projectDirectory: dataDirectory,
      model: { connectionId: "supergrok", modelId: "grok-build" },
      reasoning: "none",
    });
    await host.prompt(session.id, { text: "hello" });
    await host.waitForIdle(session.id);

    expect(refreshes).toBe(1);
    expect(authorizations).toEqual(["Bearer old-access", "Bearer new-access"]);
    expect(
      JSON.parse(await readFile(join(dataDirectory, HOST_STATE_FILENAME), "utf8")),
    ).toMatchObject({
      secrets: {
        subscriptionTokens: {
          xai: { accessToken: "new-access", refreshToken: "rotated-refresh" },
        },
      },
    });
    await host.close();
  });

  test("coalesces concurrent proactive SuperGrok refreshes", async () => {
    const dataDirectory = await directory();
    await writeFile(
      join(dataDirectory, "opengui-host-secrets.json"),
      JSON.stringify({
        subscriptions: {
          xai: { accessToken: "expired", refreshToken: "refresh", expiresAt: 0 },
        },
      }),
      { mode: 0o600 },
    );
    let refreshes = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (url === "https://auth.x.ai/oauth2/token") {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return Response.json({
          access_token: "shared-access",
          refresh_token: "shared-refresh",
          expires_in: 3600,
        });
      }
      return new Response("data: [DONE]\n\n");
    });
    const host = new OpenGuiHost(dataDirectory, { fetchImpl: fetchImpl as typeof fetch });
    await host.start();
    const sessions = await Promise.all(
      ["first", "second"].map(() =>
        host.createSession({
          projectDirectory: dataDirectory,
          model: { connectionId: "supergrok", modelId: "grok-build" },
          reasoning: "none",
        }),
      ),
    );

    await Promise.all(sessions.map((session) => host.prompt(session.id, { text: "hello" })));
    await Promise.all(sessions.map((session) => host.waitForIdle(session.id)));

    expect(refreshes).toBe(1);
    expect(sessions).toHaveLength(2);
    await host.close();
  });

  test("routes Grok policy errors safely and aborts an active Responses stream", async () => {
    const errorDirectory = await directory();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deniedHost = new OpenGuiHost(errorDirectory, {
      fetchImpl: (async () =>
        new Response("upstream-secret-policy-detail", { status: 403 })) as typeof fetch,
    });
    await deniedHost.start();
    await deniedHost.upsertModelConnection({
      id: "xai-api",
      label: "xAI API",
      baseUrl: "https://api.x.ai/v1",
      modelIds: ["grok-build-0.1"],
      apiKey: "request-secret",
    });
    const deniedSession = await deniedHost.createSession({
      projectDirectory: errorDirectory,
      model: { connectionId: "xai-api", modelId: "grok-build-0.1" },
      reasoning: "none",
    });
    await deniedHost.prompt(deniedSession.id, { text: "hello" });
    await deniedHost.waitForIdle(deniedSession.id);
    const deniedSnapshot = await deniedHost.readSession(deniedSession.id);
    const failure = deniedSnapshot.entries.find((entry) => entry.kind === "run_failed");
    expect(failure?.payload.error).toContain("entitlement and organization policy");
    expect(JSON.stringify(deniedSnapshot)).not.toMatch(/request-secret|upstream-secret/);
    expect(JSON.stringify(errorLog.mock.calls)).not.toMatch(/request-secret|upstream-secret/);
    await deniedHost.close();
    errorLog.mockRestore();

    const abortDirectory = await directory();
    const abortHost = new OpenGuiHost(abortDirectory, {
      fetchImpl: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
                ),
              );
            },
          }),
        )) as typeof fetch,
    });
    await abortHost.start();
    await abortHost.upsertModelConnection({
      id: "xai-api",
      label: "xAI API",
      baseUrl: "https://api.x.ai/v1",
      modelIds: ["grok-build-0.1"],
      apiKey: "abort-secret",
    });
    const abortSession = await abortHost.createSession({
      projectDirectory: abortDirectory,
      model: { connectionId: "xai-api", modelId: "grok-build-0.1" },
      reasoning: "none",
    });
    await abortHost.prompt(abortSession.id, { text: "wait" });
    await abortHost.abort(abortSession.id);
    await abortHost.waitForIdle(abortSession.id);
    expect((await abortHost.readSession(abortSession.id)).entries.at(-1)?.kind).toBe("run_aborted");
    await abortHost.close();
  });

  test("persists an OpenCode Go API key separately and never returns it", async () => {
    const dataDirectory = await directory();
    const catalogFetch = vi.fn(async () =>
      Response.json({
        data: [{ id: "glm-5.2" }, { id: "qwen3.7-max" }, { id: "hy3-preview" }],
      }),
    );
    const host = new OpenGuiHost(dataDirectory, { fetchImpl: catalogFetch as typeof fetch });
    await host.start();
    await host.listSessions(dataDirectory);
    await host.upsertModelConnection({
      id: "opencode-go",
      label: "OpenCode Go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "go-secret",
      modelIds: ["glm-5.2"],
    });

    expect(host.listModelConnections()).toEqual([
      expect.objectContaining({
        id: "opencode-go",
        label: "OpenCode Go",
        baseUrl: "https://opencode.ai/zen/go/v1",
        defaultModelId: "glm-5.2",
        modelIds: ["glm-5.2", "qwen3.7-max"],
      }),
    ]);
    await host.close();

    const statePath = join(dataDirectory, HOST_STATE_FILENAME);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      secrets: { apiKeys: { "opencode-go": "go-secret" } },
    });
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);

    const restarted = new OpenGuiHost(dataDirectory, { fetchImpl: catalogFetch as typeof fetch });
    await restarted.start();
    await restarted.listSessions(dataDirectory);
    expect(restarted.listModelConnections()[0]?.id).toBe("opencode-go");
    await restarted.close();
  });

  test("omits authorization for keyless OpenCode Zen free models", async () => {
    const dataDirectory = await directory();
    const authorizations: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        authorizations.push(authorization);
        if (authorization) {
          return Response.json(
            { type: "error", error: { type: "AuthError", message: "Invalid API key." } },
            { status: 401 },
          );
        }
        return new Response(
          'data: {"id":"chat_1","object":"chat.completion.chunk","model":"deepseek-v4-flash-free","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
            'data: {"id":"chat_1","object":"chat.completion.chunk","model":"deepseek-v4-flash-free","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const host = new OpenGuiHost(dataDirectory);
    await host.start();
    await host.upsertModelConnection({
      id: "opencode-zen",
      label: "OpenCode Zen",
      baseUrl: "https://opencode.ai/zen/v1",
      modelIds: ["deepseek-v4-flash-free"],
    });
    const session = await host.createSession({
      projectDirectory: dataDirectory,
      model: { connectionId: "opencode-zen", modelId: "deepseek-v4-flash-free" },
      reasoning: "none",
    });
    await host.prompt(session.id, { text: "hello" });
    await host.waitForIdle(session.id);

    expect(authorizations).toEqual([""]);
    expect((await host.readSession(session.id)).entries.at(-1)?.kind).toBe("run_completed");
    await host.close();
  });

  test("rejects malformed Codex and legacy OpenCode OAuth credentials", async () => {
    const dataDirectory = await directory();
    await writeFile(
      join(dataDirectory, "opengui-host-secrets.json"),
      JSON.stringify({
        codex: { accessToken: "access" },
        subscriptions: {
          opencode: { accessToken: "oauth", refreshToken: "refresh", expiresAt: Date.now() + 1e6 },
        },
      }),
      { mode: 0o600 },
    );
    const host = new OpenGuiHost(dataDirectory);
    await host.start();
    await host.listSessions(dataDirectory);

    expect(host.codexAuthStatus().connected).toBe(false);
    expect(host.listModelConnections()).toEqual([]);
    await host.close();
  });

  test("migrates legacy Project settings into the transactional state", async () => {
    const dataDirectory = await directory();
    await writeFile(
      join(dataDirectory, "opengui-host-settings.json"),
      JSON.stringify({
        modelConnections: [],
        defaultConnectionId: null,
        projects: [dataDirectory],
      }),
    );
    const host = new OpenGuiHost(dataDirectory);
    await host.start();

    expect(await host.listProjects()).toEqual([
      { directory: dataDirectory, name: dataDirectory.split("/").at(-1) },
    ]);
    await host.disconnectSubscription("xai");
    await host.close();

    expect(
      JSON.parse(await readFile(join(dataDirectory, HOST_STATE_FILENAME), "utf8")),
    ).toMatchObject({
      settings: { projects: [dataDirectory] },
      secrets: { subscriptionTokens: {} },
    });
  });

  test("omits persisted Projects whose directories no longer exist", async () => {
    const dataDirectory = await directory();
    const missingProject = join(dataDirectory, "deleted-project");
    await writeFile(
      join(dataDirectory, "opengui-host-settings.json"),
      JSON.stringify({
        modelConnections: [],
        defaultConnectionId: null,
        projects: [missingProject, dataDirectory],
      }),
    );
    const host = new OpenGuiHost(dataDirectory);
    await host.start();

    expect(await host.listProjects()).toEqual([
      { directory: dataDirectory, name: dataDirectory.split("/").at(-1) },
    ]);
    await host.close();
  });
});
