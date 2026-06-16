import type {
  Event as OpenCodeEvent,
  PermissionRequest,
  QuestionRequest,
} from "@opencode-ai/sdk/v2/client";
import type { HarnessEvent } from "../backend.ts";
import {
  createBackendIdCodec,
  normalizeMessageSessionId,
  normalizePartSessionId,
  tagBackendSession,
  type TaggedSession,
} from "../shared.ts";

const opencodeIdCodec = createBackendIdCodec("opencode");
const toCompositeSessionId = (rawId: string) => opencodeIdCodec.compose(rawId);

export interface OpenCodeEventContext {
  directory: string;
  workspaceId?: string;
}

type OpenCodeSyncEnvelope = {
  type?: string;
  syncEvent?: { type?: string; data?: unknown; id?: string };
};

type OpenCodeEventHandler = (
  event: OpenCodeEvent,
  context: OpenCodeEventContext,
) => HarnessEvent | null;

type EventProperties = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getProperties(event: OpenCodeEvent): EventProperties {
  return event.properties as EventProperties;
}

function resolveOpenCodeLifecycleRawId(properties: EventProperties): string | null {
  const sessionID =
    typeof properties.sessionID === "string" && properties.sessionID.length > 0
      ? properties.sessionID
      : null;
  const info = properties.info;
  if (!isRecord(info)) return sessionID;
  if (typeof info._rawId === "string" && info._rawId.length > 0) return info._rawId;
  if (typeof info.id === "string" && info.id.length > 0) return info.id;
  if (typeof info.slug === "string" && info.slug.length > 0) return info.slug;
  return sessionID;
}

function resolveOpenCodeLifecycleSession(properties: EventProperties): TaggedSession | null {
  const rawId = resolveOpenCodeLifecycleRawId(properties);
  if (!rawId) return null;
  const info = isRecord(properties.info) ? properties.info : {};
  return { ...info, id: rawId, _rawId: rawId } as TaggedSession;
}

function getSessionId(properties: EventProperties): string {
  const fromProperty =
    typeof properties.sessionID === "string" && properties.sessionID.length > 0
      ? properties.sessionID
      : null;
  if (fromProperty) return fromProperty;
  const rawId = resolveOpenCodeLifecycleRawId(properties);
  if (rawId) return rawId;
  return "";
}

function tagSession(session: TaggedSession, context: OpenCodeEventContext): TaggedSession {
  return tagBackendSession("opencode", session, context);
}

function normalizeOpenCodePayload(raw: OpenCodeEvent | OpenCodeSyncEnvelope): OpenCodeEvent {
  if (raw?.type === "sync" && raw.syncEvent?.type && raw.syncEvent.data) {
    return {
      id: raw.syncEvent.id,
      type: raw.syncEvent.type.replace(/\.\d+$/, ""),
      properties: raw.syncEvent.data,
    } as OpenCodeEvent;
  }

  return raw as OpenCodeEvent;
}

export const openCodeEventHandlers: Partial<Record<string, OpenCodeEventHandler>> = {
  "session.created": (event, context) => {
    const properties = getProperties(event);
    const session = resolveOpenCodeLifecycleSession(properties);
    if (!session) return null;
    return {
      type: "session.created",
      directory: context.directory,
      workspaceId: context.workspaceId,
      session: tagSession(session, context),
    };
  },
  "session.updated": (event, context) => {
    const properties = getProperties(event);
    const session = resolveOpenCodeLifecycleSession(properties);
    if (!session) return null;
    return {
      type: "session.updated",
      directory: context.directory,
      workspaceId: context.workspaceId,
      session: tagSession(session, context),
    };
  },
  "session.deleted": (event, context) => {
    const properties = getProperties(event);
    const rawId = resolveOpenCodeLifecycleRawId(properties);
    if (!rawId) return null;
    return {
      type: "session.deleted",
      directory: context.directory,
      workspaceId: context.workspaceId,
      sessionId: toCompositeSessionId(rawId),
    };
  },
  "message.updated": (event) => {
    const { info } = getProperties(event) as Parameters<
      typeof normalizeMessageSessionId
    >[1] extends infer Message
      ? { info: Message }
      : never;
    return {
      type: "message.updated",
      message: normalizeMessageSessionId("opencode", info),
    };
  },
  "message.part.updated": (event) => {
    const { part } = getProperties(event) as Parameters<
      typeof normalizePartSessionId
    >[1] extends infer Part
      ? { part: Part }
      : never;
    return {
      type: "message.part.updated",
      part: normalizePartSessionId("opencode", part),
    };
  },
  "message.part.delta": (event) => {
    const properties = getProperties(event) as {
      sessionID: string;
      messageID: string;
      partID: string;
      field: string;
      delta: string;
    };
    return {
      id: event.id,
      type: "message.part.delta",
      sessionID: toCompositeSessionId(properties.sessionID),
      messageID: properties.messageID,
      partID: properties.partID,
      field: properties.field,
      delta: properties.delta,
    };
  },
  "message.part.removed": (event) => {
    const properties = getProperties(event) as {
      sessionID: string;
      messageID: string;
      partID: string;
    };
    return {
      type: "message.part.removed",
      sessionID: toCompositeSessionId(properties.sessionID),
      messageID: properties.messageID,
      partID: properties.partID,
    };
  },
  "message.removed": (event) => {
    const properties = getProperties(event) as { sessionID: string; messageID: string };
    return {
      type: "message.removed",
      sessionID: toCompositeSessionId(properties.sessionID),
      messageID: properties.messageID,
    };
  },
  "session.status": (event) => {
    const properties = getProperties(event) as { sessionID: string; status: { type: string } };
    return {
      type: "session.status",
      sessionID: toCompositeSessionId(properties.sessionID),
      status: properties.status,
    };
  },
  "session.idle": (event) => ({
    type: "session.status",
    sessionID: toCompositeSessionId(getSessionId(getProperties(event))),
    status: { type: "idle" },
  }),
  "permission.asked": (event) => {
    const properties = getProperties(event) as Record<string, unknown> & { sessionID: string };
    return {
      type: "permission.requested",
      request: {
        ...properties,
        sessionID: toCompositeSessionId(properties.sessionID),
      } as PermissionRequest,
    };
  },
  "permission.replied": (event) => ({
    type: "permission.cleared",
    sessionID: toCompositeSessionId(getSessionId(getProperties(event))),
  }),
  "permission.v2.asked": (event) => {
    const properties = getProperties(event) as {
      id: string;
      sessionID: string;
      action: string;
      resources?: unknown;
      save?: unknown;
      metadata?: unknown;
      source?: unknown;
    };
    return {
      type: "permission.requested",
      request: {
        id: properties.id,
        sessionID: toCompositeSessionId(properties.sessionID),
        permission: properties.action,
        patterns: Array.isArray(properties.resources)
          ? properties.resources.filter((item): item is string => typeof item === "string")
          : [],
        always: Array.isArray(properties.save)
          ? properties.save.filter((item): item is string => typeof item === "string")
          : [],
        metadata:
          properties.metadata && typeof properties.metadata === "object" ? properties.metadata : {},
        source: properties.source,
      } as PermissionRequest,
    };
  },
  "permission.v2.replied": (event) => ({
    type: "permission.cleared",
    sessionID: toCompositeSessionId(getSessionId(getProperties(event))),
  }),
  "question.asked": (event) => {
    const properties = getProperties(event) as Record<string, unknown> & { sessionID: string };
    return {
      type: "question.requested",
      request: {
        ...properties,
        sessionID: toCompositeSessionId(properties.sessionID),
      } as QuestionRequest,
    };
  },
  "question.replied": (event) => ({
    type: "question.cleared",
    sessionID: toCompositeSessionId(getSessionId(getProperties(event))),
  }),
  "question.rejected": (event) => ({
    type: "question.cleared",
    sessionID: toCompositeSessionId(getSessionId(getProperties(event))),
  }),
  "session.error": (event) => {
    const properties = getProperties(event) as {
      error?: { name: string; data?: unknown };
      sessionID?: string;
    };
    const errData = properties.error;
    if (!errData || errData.name === "MessageAbortedError") return null;
    const errMsg =
      "data" in errData &&
      errData.data &&
      typeof errData.data === "object" &&
      "message" in errData.data
        ? String((errData.data as { message: string }).message)
        : errData.name;
    return {
      type: "session.error",
      error: errMsg,
      sessionID:
        typeof properties.sessionID === "string"
          ? toCompositeSessionId(properties.sessionID)
          : undefined,
    };
  },
};

export function mapOpenCodeEvent(
  raw: OpenCodeEvent | OpenCodeSyncEnvelope,
  context: OpenCodeEventContext,
): HarnessEvent | null {
  const event = normalizeOpenCodePayload(raw);
  const handler = openCodeEventHandlers[event.type];
  return handler?.(event, context) ?? null;
}
