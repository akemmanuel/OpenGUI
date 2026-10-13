import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { ModelTransport } from "@opengui/harness";
import { OpenGuiHost } from "../host/opengui-host.ts";
import { createBackendHost } from "../create-backend-host.ts";
import { readBackendHostEnv } from "../host/env.ts";
import type { Actor } from "./types.ts";

const ALPHA = "MARKER-ALPHA prefers concise lists";
const BETA = "MARKER-BETA prefers verbose prose";

async function value<T>(response: Response): Promise<T> {
  return ((await response.json()) as { value: T }).value;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("personal instructions verification (#155)", () => {
  test("two accounts save/read/edit/delete their own text; spoofed IDs and cross-account reads stay isolated", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-personal-verify-"));
    const backend = createBackendHost({
      dataDirectory: join(root, "data"),
      env: {
        ...readBackendHostEnv(),
        identityMode: "remote",
        pathGrantsMode: "enforced",
        allowedRoots: [root],
        authToken: "",
        servesFrontend: false,
      },
      identityDatabase: new DatabaseSync(":memory:"),
      identitySecret: "personal-verify-secret-at-least-32-characters!",
      identityBaseURL: "http://localhost",
    });
    cleanups.push(async () => {
      await (await backend.hostReady).close();
      backend.identity!.database.close();
      await rm(root, { recursive: true, force: true });
    });
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
    const owner = await value<{ token: string; actor: Actor }>(setup);
    await request("/api/identity/host-policy", owner.token, "PUT", { registrationMode: "open" });
    const register = async (username: string) => {
      const response = await request("/api/identity/register", "", "POST", {
        username,
        email: `${username}@example.com`,
        password: "a sufficiently long member password",
      });
      expect(response.status).toBe(201);
      return value<{ token: string; actor: Actor }>(response);
    };
    const alice = await register("alice");
    const bob = await register("bob");

    // Fresh accounts start empty.
    expect(await value(await request("/api/host/personal-instructions", alice.token))).toEqual({
      text: "",
    });

    // Spoofed userId in the body is ignored: it still saves to the caller's own scope.
    expect(
      (
        await request("/api/host/personal-instructions", alice.token, "PUT", {
          text: ALPHA,
          userId: bob.actor.id,
        })
      ).status,
    ).toBe(200);
    expect(await value(await request("/api/host/personal-instructions", alice.token))).toEqual({
      text: ALPHA,
    });
    // Bob's scope is untouched by Alice's spoofed write.
    expect(await value(await request("/api/host/personal-instructions", bob.token))).toEqual({
      text: "",
    });
    // Spoofed userId in the query is ignored: owner reads only their own (empty) scope.
    expect(
      await value(
        await request(`/api/host/personal-instructions?userId=${alice.actor.id}`, owner.token),
      ),
    ).toEqual({ text: "" });

    // Bob saves independently; edit path works for Alice.
    expect(
      (await request("/api/host/personal-instructions", bob.token, "PUT", { text: BETA })).status,
    ).toBe(200);
    expect(
      (
        await request("/api/host/personal-instructions", alice.token, "PUT", {
          text: `${ALPHA} v2`,
        })
      ).status,
    ).toBe(200);
    expect(await value(await request("/api/host/personal-instructions", alice.token))).toEqual({
      text: `${ALPHA} v2`,
    });
    expect(await value(await request("/api/host/personal-instructions", bob.token))).toEqual({
      text: BETA,
    });

    // Oversized text is rejected with the documented validation; the saved draft is unchanged.
    expect(
      (
        await request("/api/host/personal-instructions", alice.token, "PUT", {
          text: "x".repeat(32_001),
        })
      ).status,
    ).toBe(400);
    expect(await value(await request("/api/host/personal-instructions", alice.token))).toEqual({
      text: `${ALPHA} v2`,
    });

    // Delete is an empty PUT; only the caller's scope is cleared.
    expect(
      (await request("/api/host/personal-instructions", alice.token, "PUT", { text: "  " })).status,
    ).toBe(200);
    expect(await value(await request("/api/host/personal-instructions", alice.token))).toEqual({
      text: "",
    });
    expect(await value(await request("/api/host/personal-instructions", bob.token))).toEqual({
      text: BETA,
    });

    // API credentials cannot read or write personal scopes through the user endpoints.
    const minted = await request("/api/identity/api-keys", owner.token, "POST", {
      label: "automation",
      role: "member",
    });
    expect(minted.status).toBe(201);
    const secret = await value<{ secret: string }>(minted);
    expect((await request("/api/host/personal-instructions", secret.secret)).status).toBe(403);
    expect(
      (await request("/api/host/personal-instructions", secret.secret, "PUT", { text: "nope" }))
        .status,
    ).toBe(403);
  });

  test("systemPrompt uses the requesting actor on shared sessions and never inherits personal text for API keys", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "opengui-personal-prompt-"));
    cleanups.push(async () => rm(dataDirectory, { recursive: true, force: true }));
    const project = join(dataDirectory, "project");
    await mkdir(project);
    const alice = { type: "user" as const, id: "alice", displayName: "Alice" };
    const bob = { type: "user" as const, id: "bob", displayName: "Bob" };
    const apiKey = { type: "api_key" as const, id: "key-1", displayName: "automation" };
    const seen: string[] = [];
    const model: ModelTransport = {
      async *stream(request) {
        seen.push(request.systemPrompt);
        yield { type: "text_delta" as const, delta: "Done" };
        yield { type: "completed" as const };
      },
    };
    const host = new OpenGuiHost(dataDirectory, { model });
    await host.start();
    cleanups.push(async () => host.close());
    await host.setCustomInstructions("Host rules");
    await host.setPersonalInstructions(ALPHA, alice);
    await host.setPersonalInstructions(BETA, bob);

    // Alice creates the session; Bob's turn on that shared session carries Bob's text only.
    const session = await host.createSession(
      {
        projectDirectory: project,
        model: { connectionId: "fake", modelId: "fake" },
        reasoning: "none",
      },
      alice,
    );
    await host.prompt(session.id, { text: "Alice turn", actor: alice });
    await host.waitForIdle(session.id);
    expect(seen.at(-1)).toContain(ALPHA);
    expect(seen.at(-1)).not.toContain(BETA);

    await host.prompt(session.id, { text: "Bob turn on Alice session", actor: bob });
    await host.waitForIdle(session.id);
    expect(seen.at(-1)).toContain(BETA);
    expect(seen.at(-1)).not.toContain(ALPHA);

    // API key execution inherits Host text but never a user's personal preferences.
    await host.prompt(session.id, { text: "automation turn", actor: apiKey });
    await host.waitForIdle(session.id);
    expect(seen.at(-1)).toContain("Host rules");
    expect(seen.at(-1)).not.toContain(ALPHA);
    expect(seen.at(-1)).not.toContain(BETA);
  });

  test("concurrent personal saves stay isolated per account", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "opengui-personal-concurrent-"));
    cleanups.push(async () => rm(dataDirectory, { recursive: true, force: true }));
    const alice = { type: "user" as const, id: "alice", displayName: "Alice" };
    const bob = { type: "user" as const, id: "bob", displayName: "Bob" };
    const host = new OpenGuiHost(dataDirectory, {});
    await host.start();
    cleanups.push(async () => host.close());
    await Promise.all([
      host.setPersonalInstructions(ALPHA, alice),
      host.setPersonalInstructions(BETA, bob),
    ]);
    expect(host.getPersonalInstructions(alice)).toBe(ALPHA);
    expect(host.getPersonalInstructions(bob)).toBe(BETA);

    // Restart retains both scopes without leakage.
    await host.close();
    cleanups.pop();
    const reopened = new OpenGuiHost(dataDirectory, {});
    await reopened.start();
    cleanups.push(async () => reopened.close());
    expect(reopened.getPersonalInstructions(alice)).toBe(ALPHA);
    expect(reopened.getPersonalInstructions(bob)).toBe(BETA);
  });
});
