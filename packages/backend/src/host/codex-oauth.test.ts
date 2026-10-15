import { describe, expect, test, vi } from "vite-plus/test";
import { CODEX_CLIENT_ID, revokeCodexToken } from "./codex-oauth.ts";

describe("Codex OAuth", () => {
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
