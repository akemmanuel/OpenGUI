export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface DeviceOAuthPending {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
}

export interface DeviceOAuthConfig {
  clientId: string;
  deviceEndpoint: string;
  tokenEndpoint: string;
  scope?: string;
  json?: boolean;
  fetchImpl?: typeof fetch;
}

function seconds(value: unknown, fallback: number) {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(value: Record<string, unknown>, fallback: string) {
  if (typeof value.error_description === "string") return value.error_description;
  if (typeof value.error === "string") return value.error;
  return fallback;
}

function requestBody(config: DeviceOAuthConfig, fields: Record<string, string>) {
  return config.json ? JSON.stringify(fields) : new URLSearchParams(fields);
}

async function responseObject(response: Response) {
  const value = (await response.json()) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid OAuth response");
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  if (typeof field !== "string" || !field) throw new Error(`OAuth response missing ${key}`);
  return field;
}

function tokens(value: Record<string, unknown>, previousRefresh?: string): OAuthTokens {
  const accessToken = stringField(value, "access_token");
  const refreshToken =
    typeof value.refresh_token === "string" && value.refresh_token
      ? value.refresh_token
      : previousRefresh;
  if (!refreshToken) throw new Error("OAuth response missing refresh_token");
  const expiresIn = seconds(value.expires_in, 3600);
  return { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 };
}

export async function beginDeviceOAuth(config: DeviceOAuthConfig): Promise<DeviceOAuthPending> {
  const response = await (config.fetchImpl ?? fetch)(config.deviceEndpoint, {
    method: "POST",
    headers: {
      "content-type": config.json ? "application/json" : "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: requestBody(config, {
      client_id: config.clientId,
      ...(config.scope ? { scope: config.scope } : {}),
    }),
  });
  const value = await responseObject(response);
  if (!response.ok) throw new Error(errorMessage(value, "OAuth failed"));
  const expiresIn = seconds(value.expires_in, 900);
  return {
    deviceCode: stringField(value, "device_code"),
    userCode: stringField(value, "user_code"),
    verificationUri:
      typeof value.verification_uri_complete === "string"
        ? value.verification_uri_complete
        : stringField(value, "verification_uri"),
    expiresAt: Date.now() + expiresIn * 1000,
    interval: seconds(value.interval, 5),
  };
}

export async function pollDeviceOAuth(config: DeviceOAuthConfig, pending: DeviceOAuthPending) {
  const response = await (config.fetchImpl ?? fetch)(config.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": config.json ? "application/json" : "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: requestBody(config, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: config.clientId,
      device_code: pending.deviceCode,
    }),
  });
  const value = await responseObject(response);
  if (!response.ok) {
    if (value.error === "authorization_pending") return null;
    if (value.error === "slow_down") {
      pending.interval += 5;
      return null;
    }
    throw new Error(errorMessage(value, "OAuth failed"));
  }
  return tokens(value);
}

export async function refreshDeviceOAuth(config: DeviceOAuthConfig, current: OAuthTokens) {
  const response = await (config.fetchImpl ?? fetch)(config.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": config.json ? "application/json" : "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: requestBody(config, {
      grant_type: "refresh_token",
      client_id: config.clientId,
      refresh_token: current.refreshToken,
    }),
  });
  const value = await responseObject(response);
  if (!response.ok) throw new Error(errorMessage(value, "OAuth refresh failed"));
  return tokens(value, current.refreshToken);
}
