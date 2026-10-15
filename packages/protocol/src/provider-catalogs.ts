export type ProviderModelRoute = "openai-chat" | "anthropic-messages" | "responses";

/**
 * Host-scope connection ids for pi providers whose connections predate the provider list.
 * Every other pi provider's connection id is its pi provider id.
 */
const PI_PROVIDER_CONNECTION_IDS: Readonly<Record<string, string>> = {
  "openai-codex": "chatgpt-codex",
  opencode: "opencode-zen",
};

/** Retired first-party connection ids that now route to a pi provider connection. */
export const RETIRED_PROVIDER_CONNECTION_IDS: Readonly<Record<string, string>> = {
  supergrok: "xai",
  "xai-api": "xai",
};

/** Preferred model for a new connection; pi's first listed model is used otherwise. */
export const PI_PROVIDER_DEFAULT_MODELS: Readonly<Record<string, string>> = {
  "openai-codex": "gpt-5.6-sol",
  "opencode-go": "glm-5.2",
};

export function piProviderConnectionId(providerId: string) {
  return PI_PROVIDER_CONNECTION_IDS[providerId] ?? providerId;
}

export type ProviderAuthMethod = "api_key" | "oauth";

/** A pi provider and how the requesting actor can sign in to it. */
export interface HostProviderInfo {
  id: string;
  name: string;
  apiKey?: { name: string; interactive: boolean };
  oauth?: { name: string; loginLabel?: string; subscription: boolean };
  /** The actor's usable connection to this provider, if any. */
  connection?: { id: string; authType: ProviderAuthMethod; personal: boolean };
  login?: ProviderLoginStatus;
}

export type ProviderLoginPrompt =
  | {
      id: string;
      type: "text" | "secret" | "manual_code";
      message: string;
      placeholder?: string;
    }
  | {
      id: string;
      type: "select";
      message: string;
      options: Array<{ id: string; label: string; description?: string }>;
    };

export type ProviderLoginEvent =
  | { type: "info"; message: string; links?: Array<{ url: string; label?: string }> }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

export interface ProviderLoginStatus {
  providerId: string;
  method: ProviderAuthMethod;
  state: "running" | "awaiting_input" | "succeeded" | "failed" | "cancelled";
  prompt?: ProviderLoginPrompt;
  events: ProviderLoginEvent[];
  error?: string;
  connectionId?: string;
}
