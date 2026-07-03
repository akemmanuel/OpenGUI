/**
 * Pure OpenCode daemon event parsing and session connection routing (#128).
 */
import { normalizeProjectPath } from "../../../../src/lib/path.ts";
import { makeHarnessSessionIdCodec } from "./harness-adapter-kit.ts";
import type {
  OpenCodeMessageEntry,
  OpenCodeSdkResultEnvelope,
  OpenCodeTaggedSession,
} from "./opencode-bridge-types.ts";
import { OpenCodeHttpError } from "./opencode-bridge-types.ts";

const OPENCODE_SESSION_PREFIX = "opencode:";
const { toFrontendSessionId, toRawSessionId } = makeHarnessSessionIdCodec(OPENCODE_SESSION_PREFIX);

/** Narrow unknown IPC / SDK values to optional strings (no Object stringification). */
export function asHarnessString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asHarnessStringOr(value: unknown, fallback: string): string {
  return asHarnessString(value) ?? fallback;
}

export type NormalizeDirectoryHint = (value: unknown) => string | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeOpenCodeDaemonEvent(raw: {
  type?: string;
  syncEvent?: { type?: string; id?: string; data?: unknown };
}) {
  if (raw?.type === "sync" && raw.syncEvent?.type && raw.syncEvent.data) {
    return {
      id: raw.syncEvent.id,
      type: raw.syncEvent.type.replace(/\.\d+$/, ""),
      properties: raw.syncEvent.data,
    };
  }
  return raw;
}

export function getOpenCodeEventProperties(raw: unknown): Record<string, unknown> {
  const event = normalizeOpenCodeDaemonEvent(
    raw as Parameters<typeof normalizeOpenCodeDaemonEvent>[0],
  );
  if (!isRecord(event)) return {};
  const eventRecord = event as Record<string, unknown> & { properties?: unknown };
  const properties = isRecord(eventRecord.properties) ? eventRecord.properties : event;
  return isRecord(properties) ? properties : {};
}

export function extractOpenCodeEventRawSessionId(raw: unknown) {
  const properties = getOpenCodeEventProperties(raw);
  const candidates = [
    properties.sessionID,
    properties.sessionId,
    (properties.session as { id?: string } | undefined)?.id,
    (properties.info as { _rawId?: string; id?: string; slug?: string } | undefined)?._rawId,
    (properties.info as { id?: string } | undefined)?.id,
    (properties.info as { slug?: string } | undefined)?.slug,
    (properties.message as { sessionID?: string } | undefined)?.sessionID,
    (properties.part as { sessionID?: string } | undefined)?.sessionID,
    (properties.request as { sessionID?: string } | undefined)?.sessionID,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return toRawSessionId(candidate.trim());
  }
  return null;
}

export function extractOpenCodeEventSessionDirectory(
  raw: unknown,
  normalizeDirectoryHint: NormalizeDirectoryHint,
) {
  const properties = getOpenCodeEventProperties(raw);
  const info = isRecord(properties.info) ? properties.info : {};
  const session = isRecord(properties.session) ? properties.session : {};
  const message = isRecord(properties.message) ? properties.message : {};
  const part = isRecord(properties.part) ? properties.part : {};
  const request = isRecord(properties.request) ? properties.request : {};
  const metadata = isRecord(info.metadata) ? info.metadata : {};
  const path = isRecord(message.path) ? message.path : isRecord(info.path) ? info.path : {};
  const candidates = [
    info._projectDir,
    info.directory,
    metadata.directory,
    session._projectDir,
    session.directory,
    message.directory,
    part.directory,
    request.directory,
    path.cwd,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeDirectoryHint(candidate);
    if (normalized) return normalized;
  }
  return null;
}

export type OpenCodeConnectionEntry<Conn> = { projectKey: string; connection: Conn };

export type OpenCodeWindowState<Conn> = {
  projectRegistry: {
    getDirectoryConnectionEntry: (target: {
      directory?: string;
      workspaceId?: string;
    }) => OpenCodeConnectionEntry<Conn> | null;
  };
};

export function getConnectionEntryForDirectory<Conn>(
  windowState: OpenCodeWindowState<Conn>,
  directory: string | undefined,
  workspaceId: string | undefined,
) {
  if (typeof directory !== "string" || !directory.trim()) {
    return null;
  }
  return windowState.projectRegistry.getDirectoryConnectionEntry({ directory, workspaceId });
}

export function getConnectionEntryForSession<Conn>(
  windowState: OpenCodeWindowState<Conn>,
  getConnected: () => Array<OpenCodeConnectionEntry<Conn>>,
  directory: string | undefined,
  workspaceId: string | undefined,
) {
  if (directory) {
    const exact = getConnectionEntryForDirectory(windowState, directory, workspaceId);
    if (exact) return exact;
  }
  const connected = getConnected();
  return connected.length === 1 ? connected[0] : null;
}

export function getConnectionForSession<Conn>(
  windowState: OpenCodeWindowState<Conn>,
  getConnected: () => Array<OpenCodeConnectionEntry<Conn>>,
  _sessionId: string,
  directory: string | undefined,
  workspaceId: string | undefined,
): Conn | null {
  return (
    getConnectionEntryForSession(windowState, getConnected, directory, workspaceId)?.connection ??
    null
  );
}

export const SESSION_CONNECTION_NOT_FOUND = "Session connection not found";

export function normalizeOpenCodeDirectoryHint(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? normalizeProjectPath(value.trim()) : null;
}

export function tagOpenCodeSession(
  session: Record<string, unknown> | null | undefined,
  dir: string | undefined,
  workspaceId: string | undefined,
): OpenCodeTaggedSession | null | undefined {
  if (!session) return session;
  const rawId = toRawSessionId(asHarnessStringOr(session.id, ""));
  const id = toFrontendSessionId(rawId);
  const sessionDirectory =
    typeof session.directory === "string" && session.directory.trim()
      ? session.directory.trim()
      : null;
  const projectDir =
    sessionDirectory ??
    (typeof session._projectDir === "string" ? session._projectDir : undefined) ??
    dir;
  return {
    ...session,
    id,
    slug:
      typeof session.slug === "string" && session.slug.trim()
        ? toFrontendSessionId(session.slug)
        : id,
    _harnessId: "opencode",
    _rawId: rawId,
    _projectDir: projectDir ? normalizeProjectPath(projectDir) : undefined,
    _workspaceId: workspaceId ?? (session._workspaceId as string | undefined),
  };
}

export function tagOpenCodeMessageEntry(entry: OpenCodeMessageEntry | null | undefined) {
  const sessionID = toFrontendSessionId(asHarnessStringOr(entry?.info?.sessionID, ""));
  return {
    ...entry,
    info: { ...entry?.info, sessionID },
    parts: (entry?.parts ?? []).map((part) =>
      part && typeof part === "object" && "sessionID" in part ? { ...part, sessionID } : part,
    ),
  };
}

export function stripMessagePayloadBloat(messages: OpenCodeMessageEntry[]) {
  for (const message of messages) {
    const summary = message?.info?.summary;
    if (summary && typeof summary === "object" && "diffs" in summary) {
      delete summary.diffs;
    }

    if (!Array.isArray(message?.parts)) continue;
    for (const part of message.parts) {
      if (part?.type !== "tool") continue;
      const state = part.state as
        | { metadata?: { files?: Array<Record<string, unknown>> } }
        | undefined;
      const files = state?.metadata?.files;
      if (!Array.isArray(files)) continue;
      for (const file of files) {
        if (file && typeof file === "object" && typeof file.diff === "string" && file.diff.trim()) {
          delete file.before;
          delete file.after;
        }
      }
    }
  }
  return messages;
}

export function assertOpenCodeResponseOk<T>(
  result: OpenCodeSdkResultEnvelope<T> | null | undefined,
  fallbackMessage: string,
): OpenCodeSdkResultEnvelope<T> | null | undefined {
  if (!result || typeof result !== "object") return result;
  if (result.error) {
    const message =
      typeof result.error.message === "string" && result.error.message.trim()
        ? result.error.message
        : fallbackMessage;
    throw new OpenCodeHttpError(message, {
      status: result.response?.status,
      data: result.error,
    });
  }
  if (result.response && result.response.ok === false) {
    throw new OpenCodeHttpError(
      `${fallbackMessage}: ${result.response.status} ${result.response.statusText ?? ""}`,
      { status: result.response.status },
    );
  }
  return result;
}
