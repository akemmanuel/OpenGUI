import { describe, expect, test, vi } from "vite-plus/test";
import { beginDeviceOAuth, pollDeviceOAuth, refreshDeviceOAuth } from "./device-oauth.ts";

const config = {
  clientId: "client",
  deviceEndpoint: "https://auth.example/device",
  tokenEndpoint: "https://auth.example/token",
  scope: "openid offline_access",
};

describe("device OAuth", () => {
  test("uses an injected HTTP boundary and parses string intervals", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        device_code: "device",
        user_code: "CODE",
        verification_uri: "https://example/verify",
        expires_in: 600,
        interval: "6",
      }),
    );

    const pending = await beginDeviceOAuth({ ...config, fetchImpl: fetchMock as typeof fetch });

    expect(pending.interval).toBe(6);
    const init = fetchMock.mock.calls[0]?.[1];
    if (!init) throw new Error("OAuth request init was not captured");
    expect(init.headers).toMatchObject({
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    });
    expect(init.body).toBeInstanceOf(URLSearchParams);
    expect(init.body).toEqual(
      new URLSearchParams({ client_id: "client", scope: "openid offline_access" }),
    );
  });

  test("handles pending and refresh-token rotation deterministically", async () => {
    const pendingFetch = vi.fn(async () =>
      Response.json({ error: "authorization_pending" }, { status: 400 }),
    );
    await expect(
      pollDeviceOAuth(
        { ...config, fetchImpl: pendingFetch as typeof fetch },
        {
          deviceCode: "device",
          userCode: "CODE",
          verificationUri: "https://example/verify",
          expiresAt: Date.now() + 60_000,
          interval: 5,
        },
      ),
    ).resolves.toBeNull();

    const refreshFetch = vi.fn(async () =>
      Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 60 }),
    );
    await expect(
      refreshDeviceOAuth(
        { ...config, fetchImpl: refreshFetch as typeof fetch },
        { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 0 },
      ),
    ).resolves.toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
  });
});
