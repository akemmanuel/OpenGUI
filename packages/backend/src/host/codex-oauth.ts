export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH = "https://auth.openai.com";

export interface CodexTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
}
export interface DeviceAuthorization {
  deviceAuthId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid OAuth response");
  return value as Record<string, unknown>;
}
function required(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (typeof value !== "string" || !value)
    throw new Error(`Invalid OAuth response: missing ${key}`);
  return value;
}
export function accountIdFromJwt(jwt: string) {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("Invalid OAuth access token");
  const claims = object(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
  const auth = object(claims["https://api.openai.com/auth"]);
  return required(auth, "chatgpt_account_id");
}
async function json(response: Response) {
  const body = object(await response.json());
  if (!response.ok)
    throw new Error(
      typeof body.error_description === "string"
        ? body.error_description
        : typeof body.error === "string"
          ? body.error
          : `OAuth request failed (${response.status})`,
    );
  return body;
}
export async function beginCodexDeviceAuth(
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceAuthorization> {
  const body = await json(
    await fetchImpl(`${AUTH}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "OpenGUI/1.0" },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    }),
  );
  const expires = typeof body.expires_in === "number" ? body.expires_in : 900;
  return {
    deviceAuthId: required(body, "device_auth_id"),
    userCode: required(body, "user_code"),
    verificationUri:
      typeof body.verification_uri === "string" ? body.verification_uri : `${AUTH}/codex/device`,
    expiresAt: Date.now() + expires * 1000,
    interval: typeof body.interval === "number" ? body.interval : 5,
  };
}
export async function pollCodexDeviceAuth(
  device: DeviceAuthorization,
  fetchImpl: typeof fetch = fetch,
): Promise<CodexTokens | null> {
  const response = await fetchImpl(`${AUTH}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "OpenGUI/1.0" },
    body: JSON.stringify({
      device_auth_id: device.deviceAuthId,
      user_code: device.userCode,
      client_id: CODEX_CLIENT_ID,
    }),
  });
  if (response.status === 403 || response.status === 404) return null;
  const polled = await json(response);
  const token = await json(
    await fetchImpl(`${AUTH}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "OpenGUI/1.0" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: required(polled, "authorization_code"),
        redirect_uri: `${AUTH}/deviceauth/callback`,
        client_id: CODEX_CLIENT_ID,
        code_verifier: required(polled, "code_verifier"),
      }),
    }),
  );
  return tokens(token);
}
function tokens(body: Record<string, unknown>, previousRefresh?: string): CodexTokens {
  const accessToken = required(body, "access_token");
  const refreshToken =
    typeof body.refresh_token === "string" ? body.refresh_token : previousRefresh;
  if (!refreshToken) throw new Error("Invalid OAuth response: missing refresh_token");
  return {
    accessToken,
    refreshToken,
    accountId: accountIdFromJwt(accessToken),
    expiresAt: Date.now() + (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000,
  };
}
export async function refreshCodexTokens(current: CodexTokens, fetchImpl: typeof fetch = fetch) {
  return tokens(
    await json(
      await fetchImpl(`${AUTH}/oauth/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "OpenGUI/1.0",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
          client_id: CODEX_CLIENT_ID,
        }),
      }),
    ),
    current.refreshToken,
  );
}
export async function revokeCodexToken(token: string, fetchImpl: typeof fetch = fetch) {
  await fetchImpl(`${AUTH}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, client_id: CODEX_CLIENT_ID }),
  }).catch(() => undefined);
}
