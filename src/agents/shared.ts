import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client";
import type { NativeBackendEvent } from "@/types/electron";
import type { AgentBackendEvent, AgentBackendTarget } from "./backend.ts";
import type { AgentBackendId } from "./index.ts";

function normalizeProjectPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  if (/^[/\\]+$/.test(trimmed)) return trimmed[0] ?? trimmed;
  const windowsDriveRoot = trimmed.match(/^([A-Za-z]:)([/\\]+)$/);
  if (windowsDriveRoot) {
    return `${windowsDriveRoot[1]}${trimmed.includes("\\") ? "\\" : "/"}`;
  }
  return trimmed.replace(/[/\\]+$/, "");
}

type BridgeResult<T> =
  | { success: true; data?: T }
  | { success: false; error?: string }
  | { success: boolean; data?: T; error?: string };

type SessionTags = {
  _projectDir?: string;
  _workspaceId?: string;
  _backendId?: AgentBackendId;
  _rawId?: string;
};

export type TaggedSession = Session & SessionTags;
type BackendEventTarget = { directory?: string; workspaceId?: string };

export function requireSuccess<T>(result: BridgeResult<T>, fallback: string): T {
  if (result.success) return result.data as T;
  throw new Error(result.error ?? fallback);
}

export function createBackendIdCodec(prefix: AgentBackendId) {
  const marker = `${prefix}:`;
  return {
    compose: (rawId: string) => (rawId.startsWith(marker) ? rawId : `${marker}${rawId}`),
    decompose: (sessionId: string) =>
      sessionId.startsWith(marker) ? sessionId.slice(marker.length) : sessionId,
    matches: (sessionId: string | null | undefined) => Boolean(sessionId?.startsWith(marker)),
  };
}

export function getTarget(target?: AgentBackendTarget) {
  return {
    directory: target?.directory,
    workspaceId: target?.workspaceId,
  };
}

export function tagBackendSession(
  backendId: AgentBackendId,
  session: TaggedSession,
  target?: { directory?: string; workspaceId?: string },
): TaggedSession {
  const rawId = session._rawId ?? session.id;
  const projectDir = target?.directory ?? session._projectDir ?? session.directory;
  return {
    ...session,
    id: createBackendIdCodec(backendId).compose(rawId),
    _projectDir: projectDir ? normalizeProjectPath(projectDir) : undefined,
    _workspaceId:
      target?.workspaceId ??
      session._workspaceId ??
      ("workspaceID" in session && typeof session.workspaceID === "string"
        ? session.workspaceID
        : undefined),
    _backendId: backendId,
    _rawId: rawId,
  };
}

export function normalizeMessageSessionId(backendId: AgentBackendId, message: Message): Message {
  return {
    ...message,
    sessionID: createBackendIdCodec(backendId).compose(message.sessionID),
  };
}

export function normalizePartSessionId(backendId: AgentBackendId, part: Part): Part {
  return "sessionID" in part && typeof part.sessionID === "string"
    ? ({
        ...part,
        sessionID: createBackendIdCodec(backendId).compose(part.sessionID),
      } as Part)
    : part;
}

function normalizeBridgeConnectionStatus(event: NativeBackendEvent): AgentBackendEvent | null {
  if (event.type !== "connection:status") return null;
  return {
    type: "connection.status",
    directory: event.directory,
    workspaceId: event.workspaceId,
    status: event.payload,
  };
}

export function normalizeTaggedBackendEvent(
  backendId: AgentBackendId,
  event: NativeBackendEvent,
  nativeEventType: string,
): AgentBackendEvent | null {
  const connectionStatus = normalizeBridgeConnectionStatus(event);
  if (connectionStatus) return connectionStatus;
  if (event.type !== nativeEventType) return null;

  const payload = (event.payload ?? null) as AgentBackendEvent | null;
  if (!payload) return null;

  const codec = createBackendIdCodec(backendId);
  const tagSession = (session: TaggedSession, target: BackendEventTarget) =>
    tagBackendSession(backendId, session, target);

  switch (payload.type) {
    case "session.created":
    case "session.updated":
      return {
        ...payload,
        session: tagSession(payload.session, {
          directory: payload.directory,
          workspaceId: payload.workspaceId,
        }),
      };
    case "session.replaced":
      return {
        ...payload,
        oldId: codec.compose(payload.oldId),
        newId: codec.compose(payload.newId),
        session: tagSession(payload.session, {
          directory: payload.directory,
          workspaceId: payload.workspaceId,
        }),
      };
    case "session.deleted":
      return { ...payload, sessionId: codec.compose(payload.sessionId) };
    default:
      return normalizeBackendEventPayload(backendId, payload);
  }
}

function normalizeBackendEventPayload(
  backendId: AgentBackendId,
  payload: AgentBackendEvent,
): AgentBackendEvent {
  const codec = createBackendIdCodec(backendId);
  switch (payload.type) {
    case "message.updated":
      return {
        ...payload,
        message: normalizeMessageSessionId(backendId, payload.message),
      };
    case "message.replaced":
      return {
        ...payload,
        sessionID: codec.compose(payload.sessionID),
        message: normalizeMessageSessionId(backendId, payload.message),
        parts: payload.parts.map((part) => normalizePartSessionId(backendId, part)),
      };
    case "message.part.updated":
      return {
        ...payload,
        part: normalizePartSessionId(backendId, payload.part),
      };
    case "message.part.delta":
    case "message.part.removed":
    case "message.removed":
    case "session.status":
    case "permission.cleared":
    case "question.cleared":
      return { ...payload, sessionID: codec.compose(payload.sessionID) };
    case "permission.requested":
      return {
        ...payload,
        request: {
          ...payload.request,
          sessionID: codec.compose(payload.request.sessionID),
        },
      };
    case "question.requested":
      return {
        ...payload,
        request: {
          ...payload.request,
          sessionID: codec.compose(payload.request.sessionID),
        },
      };
    default:
      return payload;
  }
}
