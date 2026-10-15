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

const GROK = {
  id: "grok-build-0.1",
  name: "Grok Build 0.1",
  api: "openai-responses",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 256_000,
  maxTokens: 64_000,
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
};

function requestUrl(input: string | URL | Request) {
  return input instanceof Request ? input.url : input instanceof URL ? input.href : input;
}

/** A minimal OpenAI Responses SSE body carrying one assistant message. */
function responsesText(text: string) {
  return new Response(
    [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      },
      {
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "" },
      },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text }],
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          status: "completed",
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** Answers every pi sign-in prompt from `answers`, in order. */
async function signIn(
  host: OpenGuiHost,
  providerId: string,
  method: "api_key" | "oauth",
  answers: string[],
) {
  let status = host.beginProviderLogin(providerId, method);
  for (let tick = 0; tick < 200 && status.state === "running"; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    status = host.providerLoginStatus(providerId) ?? status;
  }
  for (const answer of answers) {
    expect(status.state).toBe("awaiting_input");
    status = await host.respondProviderLogin(providerId, status.prompt!.id, answer);
  }
  return status;
}

describe("OpenGuiHost authentication persistence", () => {
  test("offers and runs a newly published Codex model, including after an offline restart", async () => {
    const dataDirectory = await directory();
    await writeFile(
      join(dataDirectory, "opengui-host-secrets.json"),
      JSON.stringify({
        codex: {
          accessToken: "access",
          refreshToken: "refresh",
          accountId: "account",
          expiresAt: Date.now() + 3600000,
        },
      }),
    );
    const fetchImpl = vi.fn(async () =>
      Response.json({
        "gpt-6-astra": {
          id: "gpt-6-astra",
          name: "GPT-6 Astra",
          api: "openai-codex-responses",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 272000,
          maxTokens: 128000,
          cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 0 },
          thinkingLevelMap: { off: null, max: "max", xhigh: "xhigh" },
        },
      }),
    );
    const host = new OpenGuiHost(dataDirectory, {
      fetchImpl: fetchImpl as typeof fetch,
      model: {
        async *stream(request) {
          expect(
            request.context.findLast((item) => item.type === "user_message")?.model.modelId,
          ).toBe("gpt-6-astra");
          yield { type: "text_delta", delta: "hello" };
          yield { type: "completed" };
        },
      },
    });
    await host.start();
    try {
      expect(host.listModelConnections()[0]?.modelIds).toContain("gpt-6-astra");
      const session = await host.createSession({
        projectDirectory: dataDirectory,
        model: { connectionId: "chatgpt-codex", modelId: "gpt-6-astra" },
        reasoning: "max",
      });
      await host.prompt(session.id, { text: "hello" });
      await host.waitForIdle(session.id);
      expect((await host.readSession(session.id)).entries.at(-1)?.kind).toBe("run_completed");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await host.close();
    }
    const offline = vi.fn().mockRejectedValue(new Error("offline"));
    const restarted = new OpenGuiHost(dataDirectory, { fetchImpl: offline });
    await restarted.start();
    try {
      await restarted.refreshModelCatalogs(true);
      expect(restarted.listModelConnections()[0]?.modelIds).toContain("gpt-6-astra");
    } finally {
      await restarted.close();
    }
  });
  test("refreshes the Codex catalog when only personal subscriptions exist", async () => {
    const dataDirectory = await directory();
    const initial = new OpenGuiHost(dataDirectory, {
      fetchImpl: vi.fn().mockRejectedValue("offline"),
    });
    await initial.start();
    await initial.setCustomInstructions("initialize state");
    await initial.close();
    const statePath = join(dataDirectory, HOST_STATE_FILENAME);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.secrets.personalCodexTokens = {
      "member-1": {
        connectionId: "personal-opaque",
        tokens: {
          accessToken: "access",
          refreshToken: "refresh",
          accountId: "account",
          expiresAt: Date.now() + 3_600_000,
        },
      },
    };
    await writeFile(statePath, JSON.stringify(state));
    const fetchImpl = vi.fn(async () => Response.json({}));
    const host = new OpenGuiHost(dataDirectory, { fetchImpl: fetchImpl as typeof fetch });

    await host.start();
    try {
      expect(fetchImpl).toHaveBeenCalledWith(
        "https://pi.dev/api/models/providers/openai-codex",
        expect.any(Object),
      );
    } finally {
      await host.close();
    }
  });

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
      if (url === "https://pi.dev/api/models/providers/openai-codex") {
        return Response.json([
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            api: "openai-codex-responses",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 272000,
            maxTokens: 128000,
            cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          },
        ]);
      }
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
      secrets: {
        providerCredentials: {
          "chatgpt-codex": {
            providerId: "openai-codex",
            credential: { type: "oauth", refresh: "refresh-rotated", accountId: "account-new" },
          },
        },
      },
    });
    const diagnosticsPath = join(dataDirectory, CODEX_DIAGNOSTICS_FILENAME);
    const diagnostics = await readFile(diagnosticsPath, "utf8");
    expect((await stat(diagnosticsPath)).mode & 0o777).toBe(0o600);
    expect(diagnostics).toContain('"attempts":2');
    expect(diagnostics).not.toMatch(/refresh-rotated|account-new|signature/);
    await host.close();
    vi.unstubAllGlobals();
  });

  test("signs in to xAI with an API key through pi and streams its Responses API", async () => {
    const dataDirectory = await directory();
    const requests: Array<{ url: string; authorization: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === "https://pi.dev/api/models/providers/xai") return Response.json([GROK]);
        requests.push({
          url,
          authorization: new Headers(init?.headers).get("authorization") ?? "",
          body: typeof init?.body === "string" ? init.body : "",
        });
        return responsesText("grok ok");
      }),
    );
    const host = new OpenGuiHost(dataDirectory);
    await host.start();
    try {
      expect(host.listModelConnections()).toEqual([]);
      await expect(
        host.upsertModelConnection({
          id: "xai",
          label: "xAI",
          baseUrl: "https://api.x.ai/v1",
          modelIds: ["grok-build-0.1"],
          apiKey: "xai-api-secret",
        }),
      ).rejects.toThrow("reserved");
      expect(await signIn(host, "xai", "api_key", ["xai-api-secret"])).toMatchObject({
        state: "succeeded",
        connectionId: "xai",
      });
      expect(host.listModelConnections()).toEqual([
        expect.objectContaining({ id: "xai", providerId: "xai", modelIds: ["grok-build-0.1"] }),
      ]);
      expect(JSON.stringify(host.listModelConnections())).not.toContain("xai-api-secret");
      expect(JSON.stringify(host.listProviders())).not.toContain("xai-api-secret");
      // Sessions created against the retired first-party id keep working.
      const session = await host.createSession({
        projectDirectory: dataDirectory,
        model: { connectionId: "xai-api", modelId: "grok-build-0.1" },
        reasoning: "medium",
      });
      await host.prompt(session.id, { text: "hello" });
      await host.waitForIdle(session.id);

      const entries = (await host.readSession(session.id)).entries;
      expect(entries.at(-1)?.kind).toBe("run_completed");
      expect(JSON.stringify(entries)).toContain("grok ok");
      expect(requests).toEqual([
        expect.objectContaining({
          url: "https://api.x.ai/v1/responses",
          authorization: "Bearer xai-api-secret",
        }),
      ]);
      expect(requests[0]?.body).toContain('"model":"grok-build-0.1"');
    } finally {
      await host.close();
    }
  });

  test("refreshes a rejected SuperGrok token once and persists the rotation", async () => {
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === "https://pi.dev/api/models/providers/xai") return Response.json([GROK]);
        if (url === "https://auth.x.ai/oauth2/token") {
          refreshes += 1;
          return Response.json({
            access_token: "new-access",
            refresh_token: "rotated-refresh",
            expires_in: 3600,
          });
        }
        authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
        if (authorizations.length === 1) {
          return Response.json({ error: { message: "expired" } }, { status: 401 });
        }
        return responsesText("proxy ok");
      }),
    );
    const host = new OpenGuiHost(dataDirectory);
    await host.start();
    try {
      const session = await host.createSession({
        projectDirectory: dataDirectory,
        model: { connectionId: "supergrok", modelId: "grok-build-0.1" },
        reasoning: "none",
      });
      await host.prompt(session.id, { text: "hello" });
      await host.waitForIdle(session.id);

      expect((await host.readSession(session.id)).entries.at(-1)?.kind).toBe("run_completed");
      expect(refreshes).toBe(1);
      expect(authorizations).toEqual(["Bearer old-access", "Bearer new-access"]);
      expect(
        JSON.parse(await readFile(join(dataDirectory, HOST_STATE_FILENAME), "utf8")),
      ).toMatchObject({
        secrets: {
          providerCredentials: {
            xai: {
              providerId: "xai",
              credential: { type: "oauth", access: "new-access", refresh: "rotated-refresh" },
            },
          },
        },
      });
    } finally {
      await host.close();
    }
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url === "https://pi.dev/api/models/providers/xai") return Response.json([GROK]);
        if (url === "https://auth.x.ai/oauth2/token") {
          refreshes += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return Response.json({
            access_token: "shared-access",
            refresh_token: "shared-refresh",
            expires_in: 3600,
          });
        }
        return responsesText("ok");
      }),
    );
    const host = new OpenGuiHost(dataDirectory);
    await host.start();
    try {
      const sessions = await Promise.all(
        ["first", "second"].map(() =>
          host.createSession({
            projectDirectory: dataDirectory,
            model: { connectionId: "xai", modelId: "grok-build-0.1" },
            reasoning: "none",
          }),
        ),
      );
      await Promise.all(sessions.map((session) => host.prompt(session.id, { text: "hello" })));
      await Promise.all(sessions.map((session) => host.waitForIdle(session.id)));
      expect(refreshes).toBe(1);
    } finally {
      await host.close();
    }
  });

  test("keeps provider credentials out of failed and aborted Runs", async () => {
    const errorDirectory = await directory();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        requestUrl(input) === "https://pi.dev/api/models/providers/xai"
          ? Response.json([GROK])
          : Response.json({ error: { message: "denied by policy" } }, { status: 403 }),
      ),
    );
    const deniedHost = new OpenGuiHost(errorDirectory);
    await deniedHost.start();
    await signIn(deniedHost, "xai", "api_key", ["request-secret"]);
    const deniedSession = await deniedHost.createSession({
      projectDirectory: errorDirectory,
      model: { connectionId: "xai", modelId: "grok-build-0.1" },
      reasoning: "none",
    });
    await deniedHost.prompt(deniedSession.id, { text: "hello" });
    await deniedHost.waitForIdle(deniedSession.id);
    const deniedSnapshot = await deniedHost.readSession(deniedSession.id);
    expect(deniedSnapshot.entries.at(-1)?.kind).toBe("run_failed");
    expect(JSON.stringify(deniedSnapshot)).not.toContain("request-secret");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("request-secret");
    await deniedHost.close();
    errorLog.mockRestore();

    const abortDirectory = await directory();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        requestUrl(input) === "https://pi.dev/api/models/providers/xai"
          ? Response.json([GROK])
          : new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode(
                      'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
                    ),
                  );
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
      ),
    );
    const abortHost = new OpenGuiHost(abortDirectory);
    await abortHost.start();
    await signIn(abortHost, "xai", "api_key", ["abort-secret"]);
    const abortSession = await abortHost.createSession({
      projectDirectory: abortDirectory,
      model: { connectionId: "xai", modelId: "grok-build-0.1" },
      reasoning: "none",
    });
    await abortHost.prompt(abortSession.id, { text: "wait" });
    await abortHost.abort(abortSession.id);
    await abortHost.waitForIdle(abortSession.id);
    expect((await abortHost.readSession(abortSession.id)).entries.at(-1)?.kind).toBe("run_aborted");
    await abortHost.close();
  });

  test("stores an OpenCode Go API key as a pi credential and never returns it", async () => {
    const dataDirectory = await directory();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json([
          {
            id: "future-go-model",
            name: "Future Go Model",
            api: "openai-completions",
            reasoning: false,
            input: ["text"],
            contextWindow: 128000,
            maxTokens: 16000,
            cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          },
        ]),
      ),
    );
    const host = new OpenGuiHost(dataDirectory);
    await host.start();
    await signIn(host, "opencode-go", "api_key", ["go-secret"]);

    expect(host.listModelConnections()).toEqual([
      expect.objectContaining({
        id: "opencode-go",
        label: "OpenCode Go",
        providerId: "opencode-go",
        authType: "api_key",
        modelIds: ["future-go-model"],
      }),
    ]);
    expect(host.listProviders().find((provider) => provider.id === "opencode-go")).toMatchObject({
      connection: { id: "opencode-go", authType: "api_key", personal: false },
    });
    await host.close();

    const statePath = join(dataDirectory, HOST_STATE_FILENAME);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      secrets: {
        apiKeys: {},
        providerCredentials: {
          "opencode-go": { providerId: "opencode-go", credential: { key: "go-secret" } },
        },
      },
    });
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);

    const restarted = new OpenGuiHost(dataDirectory);
    await restarted.start();
    expect(restarted.listModelConnections()[0]?.id).toBe("opencode-go");
    await restarted.disconnectProvider("opencode-go");
    expect(restarted.listModelConnections()).toEqual([]);
    await restarted.close();
  });

  test("sends keyless Zen requests with no credential and no OpenCode client impersonation", async () => {
    const dataDirectory = await directory();
    const requestHeaders: Headers[] = [];
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === "https://pi.dev/api/models/providers/opencode") {
          return Response.json([
            {
              id: "hy3-free",
              name: "Hy3 Free",
              api: "openai-completions",
              reasoning: false,
              input: ["text"],
              contextWindow: 190000,
              maxTokens: 16000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
            {
              id: "deepseek-v4-pro",
              name: "DeepSeek V4 Pro",
              api: "openai-completions",
              reasoning: false,
              input: ["text"],
              contextWindow: 190000,
              maxTokens: 16000,
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            },
          ]);
        }
        urls.push(url);
        requestHeaders.push(new Headers(init?.headers));
        return new Response(
          'data: {"id":"chat_1","object":"chat.completion.chunk","model":"hy3-free","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
            'data: {"id":"chat_1","object":"chat.completion.chunk","model":"hy3-free","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const host = new OpenGuiHost(dataDirectory);
    await host.start();
    // An empty API key enables the keyless free tier.
    await signIn(host, "opencode", "api_key", [""]);
    expect(host.listModelConnections()[0]).toMatchObject({
      id: "opencode-zen",
      modelIds: ["hy3-free"],
    });
    const session = await host.createSession({
      projectDirectory: dataDirectory,
      model: { connectionId: "opencode-zen", modelId: "hy3-free" },
      reasoning: "none",
    });
    await host.prompt(session.id, { text: "hello" });
    await host.waitForIdle(session.id);

    expect((await host.readSession(session.id)).entries.at(-1)?.kind).toBe("run_completed");
    expect(urls).toEqual(["https://opencode.ai/zen/v1/chat/completions"]);
    const headers = requestHeaders[0]!;
    expect(headers.has("authorization")).toBe(false);
    expect(headers.get("user-agent") ?? "").not.toContain("opencode");
    expect(headers.has("x-opencode-client")).toBe(false);
    expect(headers.has("x-opencode-project")).toBe(false);
    expect(headers.has("x-opencode-request")).toBe(false);
    expect(JSON.stringify([...headers])).not.toContain("public");
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

    expect(
      host.listProviders().find((provider) => provider.id === "openai-codex")?.connection,
    ).toBeUndefined();
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
    await host.disconnectProvider("xai");
    await host.close();

    expect(
      JSON.parse(await readFile(join(dataDirectory, HOST_STATE_FILENAME), "utf8")),
    ).toMatchObject({
      settings: { projects: [dataDirectory] },
      secrets: { providerCredentials: {} },
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
