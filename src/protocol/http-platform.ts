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

export function appendTarget(target?: HarnessTarget, ...args: unknown[]) {
  return [...targetArgs(target), ...args];
}

type BridgeOp = <T>(suffix: string, args?: unknown[]) => Promise<T>;

function createPlatformOp(op: BridgeOp) {
  return async <T>(suffix: string, fallback: string, args: unknown[] = []) =>
    unwrapBridgeResult(await op<T | IPCResult<T>>(suffix, args), fallback);
}

function createProvidersPlatform(
  platformOp: ReturnType<typeof createPlatformOp>,
): NonNullable<HarnessDescriptor["platform"]>["providers"] {
  return {
    listAll: (target?: HarnessTarget) =>
      platformOp("provider:list", "Failed to list providers", targetArgs(target)),
    getAuthMethods: (target?: HarnessTarget) =>
      platformOp(
        "provider:auth-methods",
        "Failed to load provider auth methods",
        targetArgs(target),
      ),
    connect: (target: HarnessTarget, providerID: string, auth: unknown) =>
      platformOp(
        "provider:connect",
        `Failed to connect provider: ${providerID}`,
        appendTarget(target, providerID, auth),
      ),
    disconnect: (target: HarnessTarget, providerID: string) =>
      platformOp(
        "provider:disconnect",
        `Failed to disconnect provider: ${providerID}`,
        appendTarget(target, providerID),
      ),
    oauthAuthorize: (target: HarnessTarget, providerID: string, method?: number) =>
      platformOp(
        "provider:oauth:authorize",
        `Failed to start OAuth for provider: ${providerID}`,
        appendTarget(target, providerID, method),
      ),
    oauthCallback: (target: HarnessTarget, providerID: string, method?: number, code?: string) =>
      platformOp(
        "provider:oauth:callback",
        `Failed to complete OAuth for provider: ${providerID}`,
        appendTarget(target, providerID, method, code),
      ),
    dispose: (target?: HarnessTarget) =>
      platformOp("instance:dispose", "Failed to dispose provider instance", targetArgs(target)),
  };
}

export function createHarnessPlatform(
  capabilities: HarnessDescriptor["capabilities"],
  op: <T>(suffix: string, args?: unknown[]) => Promise<T>,
): HarnessDescriptor["platform"] {
  const platformOp = createPlatformOp(op);

  const platform: NonNullable<HarnessDescriptor["platform"]> = {};

  if (capabilities.localServer) {
    platform.server = {
      start: () => platformOp("server:start", "Failed to start server"),
      stop: () => platformOp("server:stop", "Failed to stop server"),
      status: () => platformOp("server:status", "Failed to get server status"),
    };
  }

  if (capabilities.providerAuth) platform.providers = createProvidersPlatform(platformOp);

  if (capabilities.mcp) {
    platform.mcp = {
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
    };
  }

  if (capabilities.config) {
    platform.config = {
      get: (target) => platformOp("config:get", "Failed to load config", targetArgs(target)),
      update: (target, config) =>
        platformOp("config:update", "Failed to update config", appendTarget(target, config)),
    };
  }

  return Object.keys(platform).length ? platform : undefined;
}
