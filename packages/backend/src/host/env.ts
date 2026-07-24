import { homedir } from "node:os";
import { normalizeAllowedRoots } from "./path-safety.ts";

export type BackendHostEnv = {
  port: number;
  hostname: string;
  isProduction: boolean;
  serverMode: string;
  servesFrontend: boolean;
  authToken: string;
  allowedCorsOrigin: string;
  allowedRoots: string[];
  uploadMaxFileBytes: number;
  uploadMaxBatchBytes: number;
  identityMode: "remote" | "desktop-local";
  pathGrantsMode?: "disabled" | "enforced";
};

function parsePositiveIntegerEnv(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseAllowedRoots() {
  const raw = process.env.OPENGUI_ALLOWED_ROOTS || homedir();
  return normalizeAllowedRoots(raw.split(","));
}

export function readBackendHostEnv(): BackendHostEnv {
  const serverMode = (process.env.OPENGUI_SERVER_MODE || process.env.OPENGUI_MODE || "combined")
    .trim()
    .toLowerCase();
  const hostname = process.env.HOST || "127.0.0.1";
  const configuredIdentityMode = process.env.OPENGUI_IDENTITY_MODE?.trim().toLowerCase();
  if (
    configuredIdentityMode &&
    configuredIdentityMode !== "remote" &&
    configuredIdentityMode !== "desktop-local"
  ) {
    throw new Error("OPENGUI_IDENTITY_MODE must be 'remote' or 'desktop-local'");
  }
  const identityMode =
    configuredIdentityMode === "desktop-local" ||
    (!configuredIdentityMode && process.env.OPENGUI_MODE === "desktop-sidecar")
      ? "desktop-local"
      : "remote";
  const configuredPathGrantsMode = process.env.OPENGUI_PATH_GRANTS?.trim().toLowerCase();
  if (
    configuredPathGrantsMode &&
    configuredPathGrantsMode !== "disabled" &&
    configuredPathGrantsMode !== "enforced"
  ) {
    throw new Error("OPENGUI_PATH_GRANTS must be 'disabled' or 'enforced'");
  }
  if (
    identityMode === "desktop-local" &&
    (serverMode !== "desktop-sidecar" || !["127.0.0.1", "::1", "localhost"].includes(hostname))
  ) {
    throw new Error("Desktop Local identity bypass requires the loopback desktop sidecar");
  }

  return {
    port: Number(process.env.PORT || 3000),
    hostname,
    isProduction: process.env.NODE_ENV === "production",
    serverMode,
    servesFrontend: !["api", "api-only", "backend", "backend-only"].includes(serverMode),
    authToken: process.env.OPENGUI_AUTH_TOKEN?.trim() || "",
    allowedCorsOrigin: process.env.OPENGUI_CORS_ORIGIN?.trim() || "*",
    allowedRoots: parseAllowedRoots(),
    uploadMaxFileBytes: parsePositiveIntegerEnv("OPENGUI_UPLOAD_MAX_FILE_BYTES", 100 * 1024 * 1024),
    uploadMaxBatchBytes: parsePositiveIntegerEnv(
      "OPENGUI_UPLOAD_MAX_BATCH_BYTES",
      500 * 1024 * 1024,
    ),
    identityMode,
    pathGrantsMode:
      configuredPathGrantsMode === "disabled"
        ? "disabled"
        : configuredPathGrantsMode === "enforced" || identityMode === "remote"
          ? "enforced"
          : "disabled",
  };
}
