/**
 * Requests the Files panel makes to the Host's `/api/fs/*` routes. Access is
 * always checked by the Host (path grants and allowed roots).
 */
import { useContext, useMemo } from "react";
import { WorkspaceContext } from "@/hooks/agent-contexts";
import { TEXT_PREVIEW_MAX_BYTES, type TextEncodingGuess } from "@/lib/host-files";

export type HostFileErrorKind = "forbidden" | "notFound" | "tooLarge" | "failed";

export class HostFileError extends Error {
  constructor(
    readonly kind: HostFileErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export type HostDirectoryEntry = {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number;
  modifiedAt?: number;
};

export type HostDirectoryListing = {
  path: string;
  parent: string | null;
  entries: HostDirectoryEntry[];
};

export type HostFileInfo = {
  path: string;
  name: string;
  size: number;
  modifiedAt: number;
  textEncoding: TextEncodingGuess;
};

export type HostFileClient = {
  list(path: string, signal?: AbortSignal): Promise<HostDirectoryListing>;
  stat(path: string, signal?: AbortSignal): Promise<HostFileInfo>;
  search(directory: string, query: string, signal?: AbortSignal): Promise<string[]>;
  /** First bytes of a text file, decoded. */
  readText(file: HostFileInfo, signal?: AbortSignal): Promise<string>;
  /** A whole file within the Host's preview size limit. */
  readBytes(path: string, signal?: AbortSignal): Promise<Uint8Array>;
  pdfSource(path: string): {
    url: string;
    httpHeaders: Record<string, string>;
    withCredentials: boolean;
  };
  download(path: string, name: string): Promise<void>;
};

function errorKind(status: number, message: string): HostFileErrorKind {
  if (status === 403) return "forbidden";
  if (status === 413) return "tooLarge";
  if (/ENOENT|no such file|not a file/i.test(message)) return "notFound";
  return "failed";
}

export function createHostFileClient(
  baseUrl: string,
  token: string | null,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): HostFileClient {
  const base = baseUrl.replace(/\/+$/, "");
  const url = (route: string, params: Record<string, string>) =>
    `${base}${route}?${new URLSearchParams(params).toString()}`;

  const request = async (route: string, params: Record<string, string>, signal?: AbortSignal) => {
    const headers = new Headers();
    if (token) headers.set("authorization", `Bearer ${token}`);
    const response = await fetchImpl(url(route, params), {
      headers,
      signal,
      credentials: "same-origin",
    });
    if (response.ok) return response;
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the status message.
    }
    throw new HostFileError(errorKind(response.status, message), message);
  };

  const json = async <T>(route: string, params: Record<string, string>, signal?: AbortSignal) => {
    const body = (await (await request(route, params, signal)).json()) as {
      ok?: boolean;
      value?: T;
      error?: string;
    };
    if (!body.ok || body.value === undefined)
      throw new HostFileError("failed", body.error ?? "Unexpected Host response");
    return body.value;
  };

  return {
    list: (path, signal) => json("/api/fs/list", { path, files: "1" }, signal),
    stat: (path, signal) => json("/api/fs/stat", { path }, signal),
    search: (directory, query, signal) =>
      json("/api/fs/search", { directory, query, limit: "100" }, signal),
    async readText(file, signal) {
      const response = await request(
        "/api/fs/file",
        { path: file.path, maxBytes: String(TEXT_PREVIEW_MAX_BYTES) },
        signal,
      );
      return new TextDecoder(file.textEncoding ?? "utf-8").decode(await response.arrayBuffer());
    },
    async readBytes(path, signal) {
      const response = await request("/api/fs/file", { path }, signal);
      return new Uint8Array(await response.arrayBuffer());
    },
    pdfSource(path) {
      const httpHeaders: Record<string, string> = {};
      if (token) httpHeaders.authorization = `Bearer ${token}`;
      return {
        url: url("/api/fs/file", { path }),
        httpHeaders,
        withCredentials: false,
      };
    },
    async download(path, name) {
      const href = url("/api/fs/file", { path, download: "1" });
      const anchor = document.createElement("a");
      anchor.download = name;
      // Content-Disposition also forces downloads from the desktop sidecar.
      if (!token) {
        anchor.href = href;
        anchor.click();
        return;
      }
      // A writable file stream keeps authenticated downloads bounded in memory.
      const picker = (
        window as unknown as {
          showSaveFilePicker?: (options: {
            suggestedName: string;
          }) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>;
        }
      ).showSaveFilePicker;
      if (picker) {
        let writable: WritableStream<Uint8Array> | null = null;
        try {
          const handle = await picker.call(window, { suggestedName: name });
          writable = await handle.createWritable();
          const response = await request("/api/fs/file", { path, download: "1" });
          if (!response.body) throw new HostFileError("failed", "Empty download response");
          await response.body.pipeTo(writable);
        } catch (error) {
          await writable?.abort().catch(() => {});
          if (error instanceof DOMException && error.name === "AbortError") return;
          throw error;
        }
        return;
      }
      // Browsers without the File System Access API use their blob download.
      const blob = await (await request("/api/fs/file", { path, download: "1" })).blob();
      const objectUrl = URL.createObjectURL(blob);
      anchor.href = objectUrl;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    },
  };
}

/** Client for the active Workspace's Host, or null before one is connected. */
export function useHostFileClient(): HostFileClient | null {
  const workspace = useContext(WorkspaceContext);
  const baseUrl = workspace?.attachmentBaseUrl ?? null;
  const token = workspace?.attachmentAuthToken ?? null;
  return useMemo(() => (baseUrl ? createHostFileClient(baseUrl, token) : null), [baseUrl, token]);
}
