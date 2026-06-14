import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client";
import type { NativeBackendEvent } from "@/types/electron";
import type { HarnessEvent, HarnessTarget } from "./backend.ts";
import type { HarnessId } from "./index.ts";
import { normalizeProjectPath } from "../lib/path.ts";
import { createBackendIdCodec } from "./id-codec.ts";

type BridgeResult<T> =
  | { success: true; data?: T }
  | { success: false; error?: string }
  | { success: boolean; data?: T; error?: string };

type SessionTags = {
  _projectDir?: string;
  _workspaceId?: string;
  _harnessId?: HarnessId;
  _rawId?: string;
};

export type TaggedSession = Session & SessionTags;
type BackendEventTarget = { directory?: string; workspaceId?: string };

export function requireSuccess<T>(result: BridgeResult<T>, fallback: string): T {
  if (result.success) return result.data as T;
  throw new Error(result.error ?? fallback);
}

export { createBackendIdCodec } from "./id-codec.ts";

export function getTarget(target?: HarnessTarget) {
  return {
    directory: target?.directory,
    workspaceId: target?.workspaceId,
  };
}

export function tagBackendSession(
  harnessId: HarnessId,
  session: TaggedSession,
  target?: { directory?: string; workspaceId?: string },
): TaggedSession {
  const rawId = session._rawId ?? session.id;
  const projectDir = session.directory ?? session._projectDir ?? target?.directory;
  return {
    ...session,
    id: createBackendIdCodec(harnessId).compose(rawId),
    _projectDir: projectDir ? normalizeProjectPath(projectDir) : undefined,
    _workspaceId:
      target?.workspaceId ??
      session._workspaceId ??
      ("workspaceID" in session && typeof session.workspaceID === "string"
        ? session.workspaceID
        : undefined),
    _harnessId: harnessId,
    _rawId: rawId,
  };
}

export function normalizeMessageSessionId(harnessId: HarnessId, message: Message): Message {
  return {
    ...message,
    sessionID: createBackendIdCodec(harnessId).compose(message.sessionID),
  };
}

export function normalizePartSessionId(harnessId: HarnessId, part: Part): Part {
  return "sessionID" in part && typeof part.sessionID === "string"
    ? ({
        ...part,
        sessionID: createBackendIdCodec(harnessId).compose(part.sessionID),
      } as Part)
    : part;
}

function normalizeBridgeConnectionStatus(event: NativeBackendEvent): HarnessEvent | null {
  if (event.type !== "connection:status") return null;
  return {
    type: "connection.status",
    directory: event.directory,
    workspaceId: event.workspaceId,
    status: event.payload,
  };
}

export function normalizeTaggedBackendEvent(
  harnessId: HarnessId,
  event: NativeBackendEvent,
  nativeEventType: string,
): HarnessEvent | null {
  const connectionStatus = normalizeBridgeConnectionStatus(event);
  if (connectionStatus) return connectionStatus;
  if (event.type !== nativeEventType) return null;

  const payload = (event.payload ?? null) as HarnessEvent | null;
  if (!payload) return null;

  const codec = createBackendIdCodec(harnessId);
  const tagSession = (session: TaggedSession, target: BackendEventTarget) =>
    tagBackendSession(harnessId, session, target);

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
      return normalizeBackendEventPayload(harnessId, payload);
  }
}

function normalizeBackendEventPayload(harnessId: HarnessId, payload: HarnessEvent): HarnessEvent {
  const codec = createBackendIdCodec(harnessId);
  switch (payload.type) {
    case "message.updated":
      return {
        ...payload,
        message: normalizeMessageSessionId(harnessId, payload.message),
      };
    case "message.replaced":
      return {
        ...payload,
        sessionID: codec.compose(payload.sessionID),
        message: normalizeMessageSessionId(harnessId, payload.message),
        parts: payload.parts.map((part) => normalizePartSessionId(harnessId, part)),
      };
    case "message.part.updated":
      return {
        ...payload,
        part: normalizePartSessionId(harnessId, payload.part),
      };
    case "message.part.delta":
    case "message.part.removed":
    case "message.removed":
    case "session.status":
    case "permission.cleared":
    case "question.cleared":
      return { ...payload, sessionID: codec.compose(payload.sessionID) };
    case "session.error":
      return payload.sessionID
        ? { ...payload, sessionID: codec.compose(payload.sessionID) }
        : payload;
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
