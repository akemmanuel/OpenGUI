import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createBackendHost, type BackendHost } from "../create-backend-host.ts";
import type { Actor } from "./types.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  while (cleanups.length) await cleanups.pop()!();
});

function headers(token: string, json = false) {
  return {
    authorization: `Bearer ${token}`,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

async function value<T>(response: Response) {
  const body = (await response.json()) as { value: T };
  return body.value;
}

async function setupOwner(backend: BackendHost) {
  return value<{ token: string; actor: Actor }>(
    await backend.app.request("http://localhost/api/identity/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "owner",
        email: "owner@example.com",
        password: "owner password is sufficiently long",
      }),
    }),
  );
}

async function register(backend: BackendHost, ownerToken: string, username: string) {
  await backend.app.request("http://localhost/api/identity/host-policy", {
    method: "PUT",
    headers: headers(ownerToken, true),
    body: JSON.stringify({ registrationMode: "open" }),
  });
  return value<{ token: string; actor: Actor }>(
    await backend.app.request("http://localhost/api/identity/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        email: `${username}@example.com`,
        password: `${username} password is sufficiently long`,
      }),
    }),
  );
}

describe("personal provider subscriptions", () => {
  test("keeps two members' xAI subscriptions independently visible and disconnectable", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-personal-subscriptions-"));
    const project = join(root, "project");
    await mkdir(project);
    let device = 0;
    const providerAuthorizations: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          input instanceof Request ? input.url : input instanceof URL ? input.href : input;
        if (url === "https://auth.x.ai/oauth2/device/code") {
          device += 1;
          return Response.json({
            device_code: `device-${device}`,
            user_code: `code-${device}`,
            verification_uri: "https://x.ai/device",
            expires_in: 900,
            interval: 1,
          });
        }
        if (url === "https://auth.x.ai/oauth2/token") {
          const body = init?.body instanceof URLSearchParams ? init.body.toString() : "";
          const match = body.match(/device_code=device-(\d+)/);
          const suffix = match?.[1] ?? "unknown";
          return Response.json({
            access_token: `access-${suffix}`,
            refresh_token: `refresh-${suffix}`,
            expires_in: 3600,
          });
        }
        if (url.startsWith("https://pi.dev/api/models/providers/")) {
          return new Response("not modified", { status: 304 });
        }
        if (url === "https://cli-chat-proxy.grok.com/v1/responses") {
          const requestHeaders = new Headers(init?.headers);
          providerAuthorizations.push(requestHeaders.get("authorization") ?? "");
          return new Response('data: {"type":"response.completed","response":{"output":[]}}\n\n', {
            headers: { "content-type": "text/event-stream" },
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    const backend = createBackendHost({
      dataDirectory: join(root, "data"),
      env: {
        port: 0,
        hostname: "127.0.0.1",
        isProduction: true,
        serverMode: "api-only",
        servesFrontend: false,
        authToken: "",
        allowedCorsOrigin: "*",
        allowedRoots: [root],
        uploadMaxFileBytes: 1024,
        uploadMaxBatchBytes: 2048,
        identityMode: "remote",
        pathGrantsMode: "enforced",
      },
      identityDatabase: new DatabaseSync(":memory:"),
      identitySecret: "personal-subscription-secret-at-least-32-characters",
      identityBaseURL: "http://localhost",
    });
    await backend.ready;
    cleanups.push(async () => {
      await (await backend.hostReady).close();
      backend.identity!.database.close();
      await rm(root, { recursive: true, force: true });
    });

    const owner = await setupOwner(backend);
    const alice = await register(backend, owner.token, "alice");
    const bob = await register(backend, owner.token, "bob");
    await backend.app.request("http://localhost/api/identity/model-policy", {
      method: "PUT",
      headers: headers(owner.token, true),
      body: JSON.stringify({
        host: { allowByok: true, allowByos: true },
        team: { allowByok: true, allowByos: true },
      }),
    });

    for (const member of [alice, bob]) {
      expect(
        (
          await backend.app.request("http://localhost/api/host/auth/xai", {
            method: "POST",
            headers: headers(member.token),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await backend.app.request("http://localhost/api/host/auth/xai/poll", {
            method: "POST",
            headers: headers(member.token),
          })
        ).status,
      ).toBe(200);
    }

    const modelsFor = async (token: string) =>
      value<Array<{ id: string; plane: string; ownerId?: string }>>(
        await backend.app.request("http://localhost/api/host/models", {
          headers: headers(token),
        }),
      );
    const [aliceModels, bobModels] = await Promise.all([
      modelsFor(alice.token),
      modelsFor(bob.token),
    ]);
    expect(aliceModels).toHaveLength(1);
    expect(bobModels).toHaveLength(1);
    expect(aliceModels[0]).toMatchObject({ plane: "user" });
    expect(bobModels[0]).toMatchObject({ plane: "user" });
    expect(aliceModels[0]!.id).not.toBe(bobModels[0]!.id);
    expect(aliceModels[0]!.id).not.toContain(alice.actor.id);
    expect(bobModels[0]!.id).not.toContain(bob.actor.id);
    expect(aliceModels[0]).not.toHaveProperty("ownerId");
    expect(bobModels[0]).not.toHaveProperty("ownerId");

    for (const [member, model] of [
      [alice, aliceModels[0]!],
      [bob, bobModels[0]!],
    ] as const) {
      await backend.app.request(`/api/identity/members/${member.actor.id}/path-grants`, {
        method: "PUT",
        headers: headers(owner.token, true),
        body: JSON.stringify({ grants: [{ root: project, access: "write" }] }),
      });
      const sessionResponse = await backend.app.request("/api/host/sessions", {
        method: "POST",
        headers: headers(member.token, true),
        body: JSON.stringify({
          directory: project,
          model: { connectionId: model.id, modelId: "grok-code-fast-1" },
          reasoning: "none",
        }),
      });
      expect(sessionResponse.status).toBe(200);
      const session = await value<{ id: string }>(sessionResponse);
      expect(
        (
          await backend.app.request(`/api/host/sessions/${session.id}/prompt`, {
            method: "POST",
            headers: headers(member.token, true),
            body: JSON.stringify({ text: `run as ${member.actor.id}` }),
          })
        ).status,
      ).toBe(200);
      await (await backend.hostReady).waitForIdle(session.id, member.actor);
    }
    expect(providerAuthorizations).toEqual(["Bearer access-1", "Bearer access-2"]);

    const crossUserSession = await backend.app.request("/api/host/sessions", {
      method: "POST",
      headers: headers(bob.token, true),
      body: JSON.stringify({
        directory: project,
        model: { connectionId: aliceModels[0]!.id, modelId: "grok-code-fast-1" },
        reasoning: "none",
      }),
    });
    expect(crossUserSession.status).toBe(403);
    expect(providerAuthorizations).toHaveLength(2);

    expect(
      (
        await backend.app.request("http://localhost/api/host/auth/xai", {
          method: "DELETE",
          headers: headers(alice.token),
        })
      ).status,
    ).toBe(200);
    expect(await modelsFor(alice.token)).toEqual([]);
    expect((await modelsFor(bob.token)).map((model) => model.id)).toEqual([bobModels[0]!.id]);
    expect(
      (await backend.identity!.listModelConnectionAccess(alice.actor)).map(
        (connection) => connection.id,
      ),
    ).not.toContain(aliceModels[0]!.id);
    expect(
      (await backend.identity!.listModelConnectionAccess(bob.actor)).map(
        (connection) => connection.id,
      ),
    ).toContain(bobModels[0]!.id);
  });

  test("uses the Host Codex credential for an entitled offering when the member also has personal Codex", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-shared-and-personal-codex-"));
    const project = join(root, "project");
    const dataDirectory = join(root, "data");
    await mkdir(project);
    await mkdir(dataDirectory);
    const jwt = (accountId: string, label: string) => {
      const payload = Buffer.from(
        JSON.stringify({ label, "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
      ).toString("base64url");
      return `header.${payload}.signature`;
    };
    await writeFile(
      join(dataDirectory, "opengui-host-secrets.json"),
      JSON.stringify({
        codex: {
          accessToken: jwt("host-account", "host-access"),
          refreshToken: "host-refresh",
          expiresAt: Date.now() + 3_600_000,
          accountId: "host-account",
        },
      }),
      { mode: 0o600 },
    );
    const providerCredentials: Array<{ authorization: string; accountId: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          input instanceof Request ? input.url : input instanceof URL ? input.href : input;
        if (url.startsWith("https://pi.dev/api/models/providers/")) {
          return Response.json([
            {
              id: "gpt-5.5",
              name: "GPT-5.5",
              api: "openai-codex-responses",
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 272_000,
              maxTokens: 128_000,
              cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
            },
          ]);
        }
        if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
          return Response.json({
            device_auth_id: "member-device",
            user_code: "member-code",
            verification_uri: "https://auth.openai.com/codex/device",
            expires_in: 900,
            interval: 1,
          });
        }
        if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
          return Response.json({ authorization_code: "member-auth", code_verifier: "verifier" });
        }
        if (url === "https://auth.openai.com/oauth/token") {
          return Response.json({
            id_token: jwt("member-account", "member-id"),
            access_token: jwt("member-account", "member-access"),
            refresh_token: "member-refresh",
            expires_in: 3600,
          });
        }
        if (url === "https://chatgpt.com/backend-api/codex/responses") {
          const requestHeaders = new Headers(init?.headers);
          providerCredentials.push({
            authorization: requestHeaders.get("authorization") ?? "",
            accountId: requestHeaders.get("chatgpt-account-id") ?? "",
          });
          return new Response(
            'data: {"type":"response.completed","response":{"id":"response","status":"completed","output":[]}}\n\n',
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    const backend = createBackendHost({
      dataDirectory,
      env: {
        port: 0,
        hostname: "127.0.0.1",
        isProduction: true,
        serverMode: "api-only",
        servesFrontend: false,
        authToken: "",
        allowedCorsOrigin: "*",
        allowedRoots: [root],
        uploadMaxFileBytes: 1024,
        uploadMaxBatchBytes: 2048,
        identityMode: "remote",
        pathGrantsMode: "enforced",
      },
      identityDatabase: new DatabaseSync(":memory:"),
      identitySecret: "mixed-codex-credential-secret-at-least-32-characters",
      identityBaseURL: "http://localhost",
    });
    await backend.ready;
    cleanups.push(async () => {
      await (await backend.hostReady).close();
      backend.identity!.database.close();
      await rm(root, { recursive: true, force: true });
    });

    const owner = await setupOwner(backend);
    const member = await register(backend, owner.token, "member_with_codex");
    await backend.app.request("/api/identity/model-policy", {
      method: "PUT",
      headers: headers(owner.token, true),
      body: JSON.stringify({
        host: { allowByok: true, allowByos: true },
        team: { allowByok: true, allowByos: true },
      }),
    });
    await backend.app.request(`/api/identity/members/${member.actor.id}/path-grants`, {
      method: "PUT",
      headers: headers(owner.token, true),
      body: JSON.stringify({ grants: [{ root: project, access: "write" }] }),
    });
    expect(
      (
        await backend.app.request("/api/host/auth/codex", {
          method: "POST",
          headers: headers(member.token),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await backend.app.request("/api/host/auth/codex/poll", {
          method: "POST",
          headers: headers(member.token),
        })
      ).status,
    ).toBe(200);
    const memberModels = await value<Array<{ id: string }>>(
      await backend.app.request("/api/host/models", { headers: headers(member.token) }),
    );
    const personalConnectionId = memberModels[0]!.id;

    await backend.app.request("/api/identity/model-offerings", {
      method: "POST",
      headers: headers(owner.token, true),
      body: JSON.stringify({
        id: "gpt-5-5",
        displayName: "gpt-5.5",
        backendId: "chatgpt-codex",
        upstreamModelId: "gpt-5.5",
      }),
    });
    await backend.app.request("/api/identity/model-offerings/gpt-5-5/entitlements", {
      method: "PUT",
      headers: headers(owner.token, true),
      body: JSON.stringify({ entitlements: [{ subjectType: "user", subjectId: member.actor.id }] }),
    });

    const run = async (connectionId: string, modelId: string, text: string) => {
      const response = await backend.app.request("/api/host/sessions", {
        method: "POST",
        headers: headers(member.token, true),
        body: JSON.stringify({
          directory: project,
          model: { connectionId, modelId },
          reasoning: "none",
        }),
      });
      expect(response.status).toBe(200);
      const session = await value<{ id: string }>(response);
      expect(
        (
          await backend.app.request(`/api/host/sessions/${session.id}/prompt`, {
            method: "POST",
            headers: headers(member.token, true),
            body: JSON.stringify({ text }),
          })
        ).status,
      ).toBe(200);
      await (await backend.hostReady).waitForIdle(session.id, member.actor);
    };

    await run("opengui-offering", "gpt-5-5", "use the shared offering");
    await run(personalConnectionId, "gpt-5.5", "use my personal connection");
    expect(providerCredentials).toEqual([
      { authorization: `Bearer ${jwt("host-account", "host-access")}`, accountId: "host-account" },
      {
        authorization: `Bearer ${jwt("member-account", "member-access")}`,
        accountId: "member-account",
      },
    ]);
  });
});
