import { DEFAULT_SERVER_URL } from "@/lib/constants";

export type ShellKind = "desktop" | "mobile" | "web";

export interface ShellWorkspacePolicy {
  shellKind: ShellKind;
  supportsMultipleWorkspaces: boolean;
  localWorkspaceMode: "desktop-local" | "web-local" | "none";
  configuredWebWorkspace: {
    baseUrl: string;
    name?: string;
    authToken?: string;
  } | null;
}

interface RuntimeConfig {
  OPENGUI_BASE_URL?: string;
  OPENGUI_WORKSPACE_NAME?: string;
  OPENGUI_AUTH_TOKEN?: string;
}

function isElectronRuntime() {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
}

function isCapacitorNativeRuntime() {
  if (typeof window === "undefined") return false;
  const capacitor = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
    .Capacitor;
  return capacitor?.isNativePlatform?.() === true;
}

function getRuntimeConfig(): RuntimeConfig {
  if (typeof window === "undefined") return {};
  return (window as unknown as { __OPENGUI_CONFIG__?: RuntimeConfig }).__OPENGUI_CONFIG__ ?? {};
}

function trimTrailingSlash(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function getConfiguredWebBaseUrl() {
  const runtimeConfig = getRuntimeConfig();
  const env = import.meta.env as Record<string, string | undefined>;
  return trimTrailingSlash(
    runtimeConfig.OPENGUI_BASE_URL ?? env.VITE_OPENGUI_BASE_URL ?? window.location.origin,
  );
}

function getConfiguredWebAuthToken() {
  const runtimeConfig = getRuntimeConfig();
  const env = import.meta.env as Record<string, string | undefined>;
  return (runtimeConfig.OPENGUI_AUTH_TOKEN ?? env.VITE_OPENGUI_AUTH_TOKEN)?.trim() || undefined;
}

function getConfiguredWebWorkspaceName(baseUrl: string) {
  const runtimeConfig = getRuntimeConfig();
  const env = import.meta.env as Record<string, string | undefined>;
  const configuredName = runtimeConfig.OPENGUI_WORKSPACE_NAME ?? env.VITE_OPENGUI_WORKSPACE_NAME;
  if (configuredName?.trim()) return configuredName.trim();
  try {
    return new URL(baseUrl).hostname || "OpenGUI";
  } catch {
    return "OpenGUI";
  }
}

export function getShellKind(): ShellKind {
  if (isElectronRuntime()) return "desktop";
  if (isCapacitorNativeRuntime()) return "mobile";
  return "web";
}

export function getShellWorkspacePolicy(): ShellWorkspacePolicy {
  const shellKind = getShellKind();
  if (shellKind === "desktop") {
    return {
      shellKind,
      supportsMultipleWorkspaces: true,
      localWorkspaceMode: "desktop-local",
      configuredWebWorkspace: null,
    };
  }
  if (shellKind === "mobile") {
    return {
      shellKind,
      supportsMultipleWorkspaces: true,
      localWorkspaceMode: "none",
      configuredWebWorkspace: null,
    };
  }

  const baseUrl = getConfiguredWebBaseUrl() || DEFAULT_SERVER_URL;
  return {
    shellKind,
    supportsMultipleWorkspaces: false,
    localWorkspaceMode: "web-local",
    configuredWebWorkspace: {
      baseUrl,
      name: getConfiguredWebWorkspaceName(baseUrl),
      authToken: getConfiguredWebAuthToken(),
    },
  };
}
