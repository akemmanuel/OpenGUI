export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH = "https://auth.openai.com";

/** Best-effort revocation on sign-out. pi owns the Codex sign-in and refresh flows. */
export async function revokeCodexToken(token: string, fetchImpl: typeof fetch = fetch) {
  await fetchImpl(`${AUTH}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token,
      token_type_hint: "refresh_token",
      client_id: CODEX_CLIENT_ID,
    }),
  }).catch(() => undefined);
}
