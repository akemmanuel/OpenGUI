import { describe, expect, it, vi } from "vite-plus/test";
import { createIdentityClient, IdentityRequestError } from "./identity-client";

describe("identity client", () => {
  it("sends setup credentials in JSON without retaining them", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            value: {
              token: "session-token",
              actor: { type: "user", id: "actor-1", displayName: "owner", role: "owner" },
              user: { id: "user-1", username: "owner", email: "owner@example.com" },
            },
          }),
          { status: 200 },
        ),
    );
    const client = createIdentityClient({ baseUrl: "https://host.example/", fetchImpl });

    const result = await client.setup({
      username: "owner",
      email: "owner@example.com",
      password: "a-secure-password",
    });

    expect(result.token).toBe("session-token");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://host.example/api/identity/setup",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          username: "owner",
          email: "owner@example.com",
          password: "a-secure-password",
        }),
      }),
    );
  });

  it("uses a bearer token for session reads", async () => {
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer session-token");
      return new Response(JSON.stringify({ ok: true, value: { actor: {}, user: {} } }));
    });
    await createIdentityClient({
      baseUrl: "https://host.example",
      token: "session-token",
      fetchImpl,
    }).me();
  });

  it("exposes response status for invalid-session handling", async () => {
    const client = createIdentityClient({
      baseUrl: "https://host.example",
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), { status: 401 }),
    });
    await expect(client.me()).rejects.toEqual(
      expect.objectContaining<Partial<IdentityRequestError>>({ status: 401 }),
    );
  });

  it("targets the owner Team routes and encodes resource ids", async () => {
    const fetchImpl = vi.fn(
      async (_input: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, value: undefined })),
    );
    const client = createIdentityClient({
      baseUrl: "https://host.example",
      token: "session-token",
      fetchImpl,
    });

    await client.revokeInvite("invite/one");
    await client.removeMember("member/one");
    await client.revokeApiKey("key/one");

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://host.example/api/identity/invites/invite%2Fone",
      "https://host.example/api/identity/members/member%2Fone",
      "https://host.example/api/identity/api-keys/key%2Fone",
    ]);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.method === "DELETE")).toBe(true);
  });

  it("uses the backend password reset field", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, value: { reset: true } })),
    );
    const client = createIdentityClient({ baseUrl: "https://host.example", fetchImpl });

    await client.resetMemberPassword("member-1", "replacement password");

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://host.example/api/identity/members/member-1/reset-password",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ password: "replacement password" }),
      }),
    );
  });

  it("sends an invite token only in the acceptance request body", async () => {
    const fetchImpl = vi.fn(
      async (_input: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            ok: true,
            value: { token: "session", actor: {}, user: {} },
          }),
        ),
    );
    await createIdentityClient({ baseUrl: "https://host.example", fetchImpl }).acceptInvite({
      token: "invite-secret",
      username: "new-member",
      email: "member@example.com",
      password: "temporary password",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://host.example/api/identity/invites/accept",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchImpl.mock.calls[0]?.[0]).not.toContain("invite-secret");
  });

  it("gets and atomically replaces the full canonical member grant set", async () => {
    const fetchImpl = vi.fn(
      async (_input: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            ok: true,
            value: {
              subject: { type: "user", id: "member/one" },
              revision: 4,
              grants: [{ root: "/srv/canonical", access: "write" }],
            },
          }),
        ),
    );
    const client = createIdentityClient({ baseUrl: "https://host.example", fetchImpl });

    await client.memberPathGrants("member/one");
    const result = await client.replaceMemberPathGrants("member/one", [
      { root: "/srv/project/../canonical", access: "write" },
    ]);

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://host.example/api/identity/members/member%2Fone/path-grants",
      "https://host.example/api/identity/members/member%2Fone/path-grants",
    ]);
    expect(fetchImpl.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          grants: [{ root: "/srv/project/../canonical", access: "write" }],
        }),
      }),
    );
    expect(result.grants).toEqual([{ root: "/srv/canonical", access: "write" }]);
  });
});
