import { describe, expect, test, vi } from "vite-plus/test";
import {
  beginCodexDeviceAuth,
  CODEX_CLIENT_ID,
  pollCodexDeviceAuth,
  refreshCodexTokens,
  revokeCodexToken,
} from "./codex-oauth.ts";

function jwt(claims: Record<string, unknown>) {
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${encoded}.signature`;
}

function oauthJwt(accountId: string) {
  return jwt({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
}

describe("Codex OAuth", () => {
  test("accepts the server's string polling interval", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const fetchImpl = vi.fn(async () =>
      Response.json({
        device_auth_id: "device",
        user_code: "CODE",
        verification_uri: "https://auth.openai.com/codex/device",
        expires_in: 600,
        interval: "7",
      }),
    );

    const pending = await beginCodexDeviceAuth(fetchImpl as typeof fetch);

    expect(pending.interval).toBe(7);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      expect.objectContaining({ body: JSON.stringify({ client_id: CODEX_CLIENT_ID }) }),
    );
  });

  test("polls with the exact device payload and reads the account from id_token", async () => {
    const accessToken = jwt({ scope: "model.request" });
    const fetchMock = vi
      .fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response())
      .mockResolvedValueOnce(Response.json({ authorization_code: "code", code_verifier: "pkce" }))
      .mockResolvedValueOnce(
        Response.json({
          id_token: oauthJwt("account-from-id-token"),
          access_token: accessToken,
          refresh_token: "refresh",
          expires_in: 3600,
        }),
      );

    const result = await pollCodexDeviceAuth(
      {
        deviceAuthId: "device",
        userCode: "CODE",
        verificationUri: "https://auth.openai.com/codex/device",
        expiresAt: Date.now() + 60_000,
        interval: 5,
      },
      fetchMock as typeof fetch,
    );

    const pollBody = fetchMock.mock.calls[0]?.[1]?.body;
    expect(typeof pollBody).toBe("string");
    expect(JSON.parse(pollBody as string)).toEqual({
      device_auth_id: "device",
      user_code: "CODE",
    });
    expect(result).toMatchObject({
      accessToken,
      refreshToken: "refresh",
      accountId: "account-from-id-token",
    });
  });

  test("requires id_token on exchange and uses refreshed id_token", async () => {
    const current = {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      accountId: "old-account",
      expiresAt: 0,
    };
    const missingIdFetch = vi.fn(async () =>
      Response.json({ access_token: oauthJwt("wrong-token"), refresh_token: "refresh" }),
    );
    await expect(refreshCodexTokens(current, missingIdFetch as typeof fetch)).rejects.toThrow(
      "id_token",
    );

    const fetchImpl = vi.fn(async () =>
      Response.json({
        id_token: oauthJwt("new-account"),
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 60,
      }),
    );
    await expect(refreshCodexTokens(current, fetchImpl as typeof fetch)).resolves.toMatchObject({
      accountId: "new-account",
      refreshToken: "new-refresh",
    });
  });

  test("revokes the refresh token with the current JSON contract", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await revokeCodexToken("refresh", fetchImpl as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/revoke",
      expect.objectContaining({
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: "refresh",
          token_type_hint: "refresh_token",
          client_id: CODEX_CLIENT_ID,
        }),
      }),
    );
  });
});
