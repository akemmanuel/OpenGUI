// @ts-nocheck
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const OPENCODE_AUTH_PATH = join(homedir(), ".local", "share", "opencode", "auth.json");
const OPENCODE_CONFIG_PATH = join(homedir(), ".config", "opencode", "opencode.json");

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

async function getOpenCodeConfigPaths(directory) {
  const paths = [];
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

export async function getOpenCodeProviderAuthKinds(directory, providers, connected) {
  const authKindByProvider = {};
  const connectedSet = new Set(Array.isArray(connected) ? connected : []);
  for (const provider of providers || []) {
    if (provider?.source === "env") authKindByProvider[provider.id] = "env";
  }

  const authData = (await readJsonIfExists(OPENCODE_AUTH_PATH)) || {};
  for (const [providerID, auth] of Object.entries(authData)) {
    if (!connectedSet.has(providerID)) continue;
    if (auth?.type === "oauth") authKindByProvider[providerID] = "subscription";
    else if (auth?.type === "api" || auth?.type === "wellknown") {
      authKindByProvider[providerID] = "api";
    }
  }

  for (const path of await getOpenCodeConfigPaths(directory)) {
    const config = await readJsonIfExists(path);
    const providerConfig = config?.provider;
    if (!providerConfig || typeof providerConfig !== "object") continue;
    for (const [providerID, entry] of Object.entries(providerConfig)) {
      if (!connectedSet.has(providerID) || authKindByProvider[providerID]) continue;
      const options = entry?.options;
      const hasLiteralApiKey =
        typeof options?.apiKey === "string" && options.apiKey.trim().length > 0;
      const hasConfiguredEnv = Array.isArray(entry?.env) && entry.env.length > 0;
      if (hasLiteralApiKey) authKindByProvider[providerID] = "api";
      else if (hasConfiguredEnv) authKindByProvider[providerID] = "env";
      else authKindByProvider[providerID] = "config";
    }
  }

  return authKindByProvider;
}
