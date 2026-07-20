import type { Provider } from "@/protocol/agent-types";

export interface ProviderAuthMethod {
  type: "oauth" | "api";
  label: string;
}

export interface ProviderOAuthAuthorization {
  url: string;
  method: "auto" | "code";
  instructions: string;
}

export type ProviderAuth =
  | { type: "api"; key: string }
  | {
      type: "oauth";
      refresh: string;
      access: string;
      expires: number;
      accountId?: string;
      enterpriseUrl?: string;
    }
  | { type: "wellknown"; key: string; token: string };

export interface AllProvidersData {
  all: Provider[];
  default: Record<string, string>;
  connected: string[];
  authKindByProvider?: Record<string, "env" | "api" | "subscription" | "config" | "custom">;
}

export interface ProvidersData {
  providers: Provider[];
  default: Record<string, string>;
}
