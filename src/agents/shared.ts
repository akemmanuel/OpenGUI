import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client";
import { normalizeProjectPath } from "@/lib/utils";
import type { AgentBackendEvent, AgentBackendTarget } from "./backend";
import type { AgentBackendId } from "./index";

export type BridgeResult<T> =
  | { success: true; data?: T }
  | { success: false; error?: string }
  | { success: boolean; data?: T; error?: string };

export type SessionTags = {
  _projectDir?: string;
  _workspaceId?: string;
  _backendId?: AgentBackendId;
  _rawId?: string;
};

export type TaggedSession = Session & SessionTags;

export function requireSuccess<T>(result: BridgeResult<T>, fallback: string): T {
  if (result.success) return result.data as T;
  throw new Error(result.error ?? fallback);
}

export function createBackendIdCodec(prefix: AgentBackendId) {
  const marker = `${prefix}:`;
  return {
    compose: (rawId: string) => `${marker}${rawId}`,
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

export function normalizeBackendEventPayload(
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
