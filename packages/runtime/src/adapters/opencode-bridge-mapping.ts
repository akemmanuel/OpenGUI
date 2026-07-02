/**
 * Pure OpenCode daemon event parsing and session connection routing (#128).
 */
import { makeHarnessSessionIdCodec } from "./harness-adapter-kit.ts";

const { toRawSessionId } = makeHarnessSessionIdCodec("opencode:");

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
