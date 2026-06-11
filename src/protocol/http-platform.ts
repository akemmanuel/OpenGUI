import type { HarnessDescriptor, HarnessTarget } from "@/agents/backend";
import type { IPCResult } from "@/types/electron";

export function targetArgs(target?: HarnessTarget) {
  return [target?.directory, target?.workspaceId];
}

export function unwrapIpcResult<T>(result: IPCResult<T>, fallback: string): T {
  if (!result?.success) throw new Error(result?.error || fallback);
  return result.data as T;
}

export function unwrapBridgeResult<T>(result: T | IPCResult<T>, fallback: string): T {
  if (
    result &&
    typeof result === "object" &&
    "success" in result &&
    typeof (result as IPCResult<T>).success === "boolean"
  ) {
    return unwrapIpcResult(result as IPCResult<T>, fallback);
  }
  return result as T;
}

function normalizeSkillList<T>(value: T[] | Record<string, T> | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

export function appendTarget(target?: HarnessTarget, ...args: unknown[]) {
  return [...targetArgs(target), ...args];
}

export function createOpenCodePlatform(
  op: <T>(suffix: string, args?: unknown[]) => Promise<T>,
): HarnessDescriptor["platform"] {
  const platformOp = async <T>(suffix: string, fallback: string, args: unknown[] = []) =>
    unwrapBridgeResult(await op<T | IPCResult<T>>(suffix, args), fallback);

  return {
    server: {
      start: () => platformOp("server:start", "Failed to start server"),
      stop: () => platformOp("server:stop", "Failed to stop server"),
      status: () => platformOp("server:status", "Failed to get server status"),
    },
    providers: {
      listAll: (target) =>
        platformOp("provider:list", "Failed to list providers", targetArgs(target)),
      getAuthMethods: (target) =>
        platformOp(
          "provider:auth-methods",
          "Failed to load provider auth methods",
          targetArgs(target),
        ),
      connect: (target, providerID, auth) =>
        platformOp(
          "provider:connect",
          `Failed to connect provider: ${providerID}`,
          appendTarget(target, providerID, auth),
        ),
      disconnect: (target, providerID) =>
        platformOp(
          "provider:disconnect",
          `Failed to disconnect provider: ${providerID}`,
          appendTarget(target, providerID),
        ),
      oauthAuthorize: (target, providerID, method) =>
        platformOp(
          "provider:oauth:authorize",
          `Failed to start OAuth for provider: ${providerID}`,
          appendTarget(target, providerID, method),
        ),
      oauthCallback: (target, providerID, method, code) =>
        platformOp(
          "provider:oauth:callback",
          `Failed to complete OAuth for provider: ${providerID}`,
          appendTarget(target, providerID, method, code),
        ),
      dispose: (target) =>
        platformOp("instance:dispose", "Failed to dispose provider instance", targetArgs(target)),
    },
    mcp: {
      status: (target) => platformOp("mcp:status", "Failed to load MCP status", targetArgs(target)),
      add: (target, name, config) =>
        platformOp(
          "mcp:add",
          `Failed to add MCP server: ${name}`,
          appendTarget(target, name, config),
        ),
      connect: (target, name) =>
        platformOp(
          "mcp:connect",
          `Failed to connect MCP server: ${name}`,
          appendTarget(target, name),
        ),
      disconnect: (target, name) =>
        platformOp(
          "mcp:disconnect",
          `Failed to disconnect MCP server: ${name}`,
          appendTarget(target, name),
        ),
    },
    skills: {
      list: async (target) =>
        normalizeSkillList(
          unwrapBridgeResult(await op("skills", targetArgs(target)), "Failed to list plugins"),
        ),
      marketplace: {
        list: async (view, page, perPage, apiKey) =>
          unwrapBridgeResult(
            await op("skills:marketplace:list", [view, page, perPage, apiKey]),
            "Failed to list plugin catalog entries",
          ),
        search: async (query, limit, apiKey) =>
          unwrapBridgeResult(
            await op("skills:marketplace:search", [query, limit, apiKey]),
            "Failed to search plugin catalog entries",
          ),
        detail: async (source, slug, apiKey) =>
          unwrapBridgeResult(
            await op("skills:marketplace:detail", [source, slug, apiKey]),
            "Failed to load plugin catalog entry",
          ),
        audit: async (source, slug, apiKey) =>
          unwrapBridgeResult(
            await op("skills:marketplace:audit", [source, slug, apiKey]),
            "Failed to audit plugin catalog entry",
          ),
        curated: async (apiKey) =>
          unwrapBridgeResult(
            await op("skills:marketplace:curated", [apiKey]),
            "Failed to load curated plugin catalog entries",
          ),
      },
      install: async (source, directory, globalScope) =>
        unwrapBridgeResult(
          await op("skills:install", [source, directory, globalScope]),
          "Failed to install plugin",
        ),
      remove: async (skillName, directory, globalScope) =>
        unwrapBridgeResult(
          await op("skills:remove", [skillName, directory, globalScope]),
          "Failed to remove plugin",
        ),
      update: async (skillName, directory, globalScope) =>
        unwrapBridgeResult(
          await op("skills:update", [skillName, directory, globalScope]),
          "Failed to update plugin",
        ),
      listInstalled: async (directory) =>
        normalizeSkillList(
          unwrapBridgeResult(
            await op("skills:list-installed", [directory]),
            "Failed to list installed plugins",
          ),
        ),
      checkCli: async () =>
        unwrapBridgeResult(await op("skills:check-cli"), "Failed to check plugins CLI"),
    },
    config: {
      get: (target) => platformOp("config:get", "Failed to load config", targetArgs(target)),
      update: (target, config) =>
        platformOp("config:update", "Failed to update config", appendTarget(target, config)),
    },
  };
}

export function createPiPlatform(
  op: <T>(suffix: string, args?: unknown[]) => Promise<T>,
): HarnessDescriptor["platform"] {
  const platformOp = async <T>(suffix: string, fallback: string, args: unknown[] = []) =>
    unwrapBridgeResult(await op<T | IPCResult<T>>(suffix, args), fallback);

  return {
    providers: {
      listAll: (target) =>
        platformOp("provider:list", "Failed to list providers", targetArgs(target)),
      getAuthMethods: (target) =>
        platformOp(
          "provider:auth-methods",
          "Failed to load provider auth methods",
          targetArgs(target),
        ),
      connect: (target, providerID, auth) =>
        platformOp(
          "provider:connect",
          `Failed to connect provider: ${providerID}`,
          appendTarget(target, providerID, auth),
        ),
      disconnect: (target, providerID) =>
        platformOp(
          "provider:disconnect",
          `Failed to disconnect provider: ${providerID}`,
          appendTarget(target, providerID),
        ),
      oauthAuthorize: (target, providerID, method) =>
        platformOp(
          "provider:oauth:authorize",
          `Failed to start OAuth for provider: ${providerID}`,
          appendTarget(target, providerID, method),
        ),
      oauthCallback: (target, providerID, method, code) =>
        platformOp(
          "provider:oauth:callback",
          `Failed to complete OAuth for provider: ${providerID}`,
          appendTarget(target, providerID, method, code),
        ),
      dispose: (target) =>
        platformOp("instance:dispose", "Failed to dispose provider instance", targetArgs(target)),
    },
  };
}
