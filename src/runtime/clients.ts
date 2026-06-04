import { createHttpOpenGuiClient } from "@/protocol/http-client";
import type { OpenGuiClient } from "@/protocol/client";
import {
  createElectronDesktopShell,
  createWebDesktopShell,
  type DesktopShellClient,
} from "@/shell/client";
import { getShellWorkspacePolicy } from "@/runtime/shell-policy";

interface RuntimeClients {
  openGuiClient: OpenGuiClient;
  desktopShell: DesktopShellClient;
}

let runtimeClients: RuntimeClients | null = null;

function isElectronRuntime() {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
}

function isCapacitorNativeRuntime() {
  const capacitor = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
    .Capacitor;
  return capacitor?.isNativePlatform?.() === true;
}

interface StoredWorkspaceConnection {
  id?: string;
  isLocal?: boolean;
  serverUrl?: string;
  authToken?: string;
  password?: string;
  username?: string;
  settings?: {
    isLocal?: boolean;
    serverUrl?: string;
    authToken?: string;
    password?: string;
    username?: string;
  };
}

function getStoredWorkspaceConnections() {
  try {
    return JSON.parse(
      localStorage.getItem("opencode:workspaces") || "[]",
    ) as StoredWorkspaceConnection[];
  } catch {
    return [];
  }
}

function getActiveWorkspaceConnection() {
  const activeWorkspaceId = localStorage.getItem("opencode:activeWorkspaceId");
  const workspaces = getStoredWorkspaceConnections();
  return workspaces.find((item) => item.id === activeWorkspaceId) ?? null;
}

function getWorkspaceUrl(workspace: StoredWorkspaceConnection | null | undefined) {
  return (workspace?.serverUrl || workspace?.settings?.serverUrl || "").replace(/\/+$/, "");
}

function getWorkspaceAuthToken(workspace: StoredWorkspaceConnection | null | undefined) {
  return (
    workspace?.authToken ||
    workspace?.settings?.authToken ||
    (!workspace?.settings?.username ? workspace?.settings?.password : undefined) ||
    (!workspace?.username ? workspace?.password : undefined) ||
    ""
  ).trim();
}

function isAdditionalWorkspace(workspace: StoredWorkspaceConnection | null | undefined) {
  return Boolean(
    workspace && workspace.id !== "local" && !workspace.isLocal && !workspace.settings?.isLocal,
  );
}

function getActiveWorkspaceServerUrl() {
  const activeWorkspace = getActiveWorkspaceConnection();
  const selectedUrl = getWorkspaceUrl(activeWorkspace);
  if (selectedUrl && isAdditionalWorkspace(activeWorkspace)) return selectedUrl;

  const remoteWorkspace = getStoredWorkspaceConnections().find((item) => {
    const url = getWorkspaceUrl(item);
    return isAdditionalWorkspace(item) && /^https?:\/\//.test(url);
  });
  return getWorkspaceUrl(remoteWorkspace);
}

function getSelectedAdditionalWorkspaceServerUrl() {
  const activeWorkspace = getActiveWorkspaceConnection();
  const selectedUrl = getWorkspaceUrl(activeWorkspace);
  return selectedUrl && isAdditionalWorkspace(activeWorkspace) ? selectedUrl : "";
}

function getActiveWorkspaceAuthToken() {
  return getWorkspaceAuthToken(getActiveWorkspaceConnection());
}

function getSelectedAdditionalWorkspaceAuthToken() {
  const activeWorkspace = getActiveWorkspaceConnection();
  return isAdditionalWorkspace(activeWorkspace) ? getWorkspaceAuthToken(activeWorkspace) : "";
}

function getWorkspaceAuthTokenForUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  for (const workspace of getStoredWorkspaceConnections()) {
    const workspaceUrl = getWorkspaceUrl(workspace);
    if (!workspaceUrl || !isAdditionalWorkspace(workspace)) continue;
    try {
      const parsedWorkspaceUrl = new URL(workspaceUrl);
      if (parsed.origin === parsedWorkspaceUrl.origin) return getWorkspaceAuthToken(workspace);
    } catch {
      // Ignore malformed stored workspace URLs.
    }
  }
  return "";
}

export function initializeRuntimeClients(): RuntimeClients {
  if (runtimeClients) return runtimeClients;

  const electronApi = window.electronAPI;
  const useElectronShell = electronApi?.kind === "electron" || isElectronRuntime();
  const useCapacitorShell = isCapacitorNativeRuntime();
  const shellWorkspacePolicy = getShellWorkspacePolicy();
  const configuredWebBaseUrl = shellWorkspacePolicy.configuredWebWorkspace?.baseUrl;
  const configuredWebAuthToken = shellWorkspacePolicy.configuredWebWorkspace?.authToken;
  const mobileBaseUrl = useCapacitorShell ? getActiveWorkspaceServerUrl : undefined;
  const browserAuthToken = useCapacitorShell
    ? getActiveWorkspaceAuthToken
    : () => configuredWebAuthToken;

  const getElectronBaseUrl = () => {
    const remoteUrl = getSelectedAdditionalWorkspaceServerUrl();
    return remoteUrl || electronApi?.backendUrl || undefined;
  };

  const getElectronAuthToken = () => {
    const remoteToken = getSelectedAdditionalWorkspaceAuthToken();
    return remoteToken || electronApi?.backendToken || undefined;
  };

  const ensureElectronBackend = async () => {
    if (!electronApi || electronApi.kind !== "electron") return null;
    if (electronApi.backendUrl) return electronApi;
    const restarted = await electronApi.restartBackend?.();
    if (restarted?.url) {
      electronApi.backendUrl = restarted.url;
      electronApi.backendToken = restarted.token;
      electronApi.backendStatus = restarted.status;
    }
    return electronApi;
  };

  const openGuiClient =
    useElectronShell && electronApi
      ? createHttpOpenGuiClient({
          baseUrl: electronApi.backendUrl ?? "",
          token: electronApi.backendToken ?? undefined,
          resolveBaseUrl: getElectronBaseUrl,
          resolveToken: getElectronAuthToken,
          fetchImpl: async (input, init) => {
            const api = await ensureElectronBackend();
            const localBaseUrl = api?.backendUrl?.replace(/\/+$/, "") ?? "";
            const resolvedBaseUrl = getElectronBaseUrl()?.replace(/\/+$/, "") ?? localBaseUrl;
            let url =
              resolvedBaseUrl && input.startsWith("/") ? `${resolvedBaseUrl}${input}` : input;
            if (resolvedBaseUrl) {
              try {
                const parsed = new URL(url);
                const localBackend = localBaseUrl ? new URL(localBaseUrl) : null;
                const isLocalhost =
                  parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
                const isElectronBackendUrl =
                  localBackend &&
                  parsed.hostname === localBackend.hostname &&
                  parsed.port === localBackend.port;
                if (
                  isLocalhost &&
                  (parsed.port === "4096" ||
                    (isElectronBackendUrl && resolvedBaseUrl !== localBaseUrl))
                ) {
                  url = `${resolvedBaseUrl}${parsed.pathname}${parsed.search}${parsed.hash}`;
                }
              } catch {
                // Non-URL inputs are passed through unchanged.
              }
            }
            const headers = new Headers(init?.headers);
            const workspaceToken = getWorkspaceAuthTokenForUrl(url);
            if (workspaceToken && !headers.has("authorization")) {
              headers.set("authorization", `Bearer ${workspaceToken}`);
            }
            return await fetch(url, { ...init, headers });
          },
          rpcImpl: async (channel, args = []) => {
            const api = await ensureElectronBackend();
            const baseUrl = api?.backendUrl?.replace(/\/+$/, "");
            if (!baseUrl) throw new Error(`Desktop backend is not available: ${channel}`);
            const headers = new Headers({ "content-type": "application/json" });
            if (api?.backendToken) headers.set("authorization", `Bearer ${api.backendToken}`);
            const response = await fetch(`${baseUrl}/api/rpc`, {
              method: "POST",
              headers,
              body: JSON.stringify({ channel, args }),
            });
            const body = await response.json().catch(() => null);
            if (!response.ok || !body?.ok) throw new Error(body?.error || `RPC failed: ${channel}`);
            return body.value;
          },
          openDirectory: () => electronApi.openDirectory(),
        })
      : createHttpOpenGuiClient({
          resolveBaseUrl: useCapacitorShell ? mobileBaseUrl : () => configuredWebBaseUrl,
          resolveToken: browserAuthToken,
        });

  runtimeClients = {
    openGuiClient,
    desktopShell:
      useElectronShell && electronApi
        ? createElectronDesktopShell(electronApi)
        : createWebDesktopShell(),
  };

  return runtimeClients;
}

export function getOpenGuiClient(): OpenGuiClient {
  return initializeRuntimeClients().openGuiClient;
}

export function getDesktopShellClient(): DesktopShellClient {
  return initializeRuntimeClients().desktopShell;
}
