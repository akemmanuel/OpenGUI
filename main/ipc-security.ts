import path from "node:path";
import { isAllowedAppNavigation } from "./desktop-shell.js";

const BACKEND_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const MAX_BACKEND_BODY_BYTES = 10 * 1024 * 1024;

export interface ValidatedBackendFetchRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function assertBackendFetchRequest(
  value: unknown,
  backendUrl: string,
): ValidatedBackendFetchRequest {
  if (!isRecord(value) || typeof value.url !== "string") {
    throw new TypeError("Invalid backend request");
  }
  const backend = new URL(backendUrl);
  const requested = new URL(value.url, backend);
  if (requested.origin !== backend.origin) throw new Error("Refusing non-Host backend request");
  const method = typeof value.method === "string" ? value.method.toUpperCase() : "GET";
  if (!BACKEND_METHODS.has(method)) throw new TypeError("Unsupported backend request method");
  const headers: Record<string, string> = {};
  if (value.headers !== undefined) {
    if (!isRecord(value.headers)) throw new TypeError("Invalid backend request headers");
    for (const [name, headerValue] of Object.entries(value.headers)) {
      if (typeof headerValue !== "string") throw new TypeError("Invalid backend request header");
      if (name.toLowerCase() === "authorization") {
        throw new Error("Renderer cannot provide Host authorization");
      }
      headers[name] = headerValue;
    }
  }
  const body = value.body == null ? undefined : value.body;
  if (body !== undefined && typeof body !== "string") throw new TypeError("Invalid backend body");
  if (body !== undefined && Buffer.byteLength(body) > MAX_BACKEND_BODY_BYTES) {
    throw new RangeError("Backend request body is too large");
  }
  return { url: value.url, method, headers, body };
}

export function assertProjectPath(
  value: unknown,
  platform: NodeJS.Platform | (string & {}),
): string {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new TypeError("Invalid project path");
  }
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  if (!platformPath.isAbsolute(value)) throw new TypeError("Project path must be absolute");
  if (platform === "win32" && !/^(?:[a-zA-Z]:\\|\\\\[^\\]+\\[^\\]+)/.test(value)) {
    throw new TypeError("Windows project path must include a drive or UNC share");
  }
  return value;
}

export function registerValidatedIpcHandler<T>(input: {
  ipcMain: {
    handle(channel: string, handler: (event: unknown, ...values: unknown[]) => unknown): unknown;
  };
  channel: string;
  appEntryUrl: string;
  validate(...values: unknown[]): T;
  handler(value: T, event: unknown): unknown;
}) {
  input.ipcMain.handle(input.channel, async (event, ...values) => {
    const frameUrl = (event as { senderFrame?: { url?: unknown } })?.senderFrame?.url;
    if (typeof frameUrl !== "string" || !isAllowedAppNavigation(frameUrl, input.appEntryUrl)) {
      throw new Error("Refusing untrusted IPC sender");
    }
    return await input.handler(input.validate(...values), event);
  });
}
