import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const OPENCODE_AUTH_PATH = join(homedir(), ".local", "share", "opencode", "auth.json");
const OPENCODE_CONFIG_PATH = join(homedir(), ".config", "opencode", "opencode.json");

type JsonObject = Record<string, unknown>;

type OpenCodeProvider = {
  id?: string;
  source?: string;
};

type OpenCodeAuth = {
  type?: string;
};

type OpenCodeProviderConfig = {
  options?: {
    apiKey?: unknown;
  };
  env?: unknown;
};

async function readJsonIfExists(path: string): Promise<JsonObject | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

async function getOpenCodeConfigPaths(directory?: string | null) {
  const paths: string[] = [];
  if (directory) {
    let current = resolve(directory);
    while (true) {
      paths.push(join(current, "opencode.json"));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  paths.push(join(homedir(), "opencode.json"));
  paths.push(OPENCODE_CONFIG_PATH);
  return Array.from(new Set(paths));
}

export async function getOpenCodeProviderAuthKinds(
  directory: string | null | undefined,
  providers: OpenCodeProvider[] | undefined,
  connected: string[] | undefined,
) {
  const authKindByProvider: Record<string, "env" | "subscription" | "api" | "config"> = {};
  const connectedSet = new Set(Array.isArray(connected) ? connected : []);
  for (const provider of providers || []) {
    if (provider?.source === "env" && provider.id) authKindByProvider[provider.id] = "env";
  }

  const authData = (await readJsonIfExists(OPENCODE_AUTH_PATH)) || {};
  for (const [providerID, auth] of Object.entries(authData)) {
    if (!connectedSet.has(providerID)) continue;
    const typedAuth = auth as OpenCodeAuth;
    if (typedAuth.type === "oauth") authKindByProvider[providerID] = "subscription";
    else if (typedAuth.type === "api" || typedAuth.type === "wellknown") {
      authKindByProvider[providerID] = "api";
    }
  }

  for (const path of await getOpenCodeConfigPaths(directory)) {
    const config = await readJsonIfExists(path);
    const providerConfig = config?.provider;
    if (!providerConfig || typeof providerConfig !== "object") continue;
    for (const [providerID, entry] of Object.entries(providerConfig)) {
      if (!connectedSet.has(providerID) || authKindByProvider[providerID]) continue;
      const typedEntry = entry as OpenCodeProviderConfig;
      const options = typedEntry.options;
      const hasLiteralApiKey =
        typeof options?.apiKey === "string" && options.apiKey.trim().length > 0;
      const hasConfiguredEnv = Array.isArray(typedEntry.env) && typedEntry.env.length > 0;
      if (hasLiteralApiKey) authKindByProvider[providerID] = "api";
      else if (hasConfiguredEnv) authKindByProvider[providerID] = "env";
      else authKindByProvider[providerID] = "config";
    }
  }

  return authKindByProvider;
}
