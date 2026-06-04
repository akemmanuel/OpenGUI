import type { Event as OpenCodeEvent } from "@opencode-ai/sdk/v2/client";
import type { NativeBackendEvent } from "@/types/electron";
import type { HarnessCapabilities, HarnessEvent } from "./backend.ts";
import {
  createBackendIdCodec,
  normalizeMessageSessionId,
  normalizePartSessionId,
  tagBackendSession,
  type TaggedSession,
} from "./shared.ts";

export const OPENCODE_CAPABILITIES: HarnessCapabilities = {
  sessions: true,
  streaming: true,
  messagePaging: true,
  models: true,
  agents: true,
  commands: true,
  compact: true,
  fork: true,
  revert: true,
  permissions: true,
  questions: true,
  providerAuth: true,
  mcp: true,
  skills: true,
  config: true,
  localServer: true,
};

export const OPENCODE_WORKSPACE = {
  kind: "remote-server",
  fields: {
    serverUrl: true,
    username: true,
    password: true,
    directory: true,
  },
} as const;

const { compose: toCompositeSessionId } = createBackendIdCodec("opencode");

function tagSession(
  session: TaggedSession,
  event: { directory: string; workspaceId?: string },
): TaggedSession {
  return tagBackendSession("opencode", session, event);
}

export function normalizeOpenCodeEvent(event: NativeBackendEvent): HarnessEvent | null {
  if (event.type === "connection:status") {
    return {
      type: "connection.status",
      directory: event.directory,
      workspaceId: event.workspaceId,
      status: event.payload,
    };
  }

  if (event.type !== "opencode:event") return null;
  const oc = event.payload as OpenCodeEvent;

  switch (oc.type) {
    case "session.created":
      return {
        type: "session.created",
        directory: event.directory,
        workspaceId: event.workspaceId,
        session: tagSession(oc.properties.info, event),
      };
    case "session.updated":
      return {
        type: "session.updated",
        directory: event.directory,
        workspaceId: event.workspaceId,
        session: tagSession(oc.properties.info, event),
      };
    case "session.deleted":
      return {
        type: "session.deleted",
        directory: event.directory,
        workspaceId: event.workspaceId,
        sessionId: toCompositeSessionId(oc.properties.info.id),
      };
    case "message.updated":
      return {
        type: "message.updated",
        message: normalizeMessageSessionId("opencode", oc.properties.info),
      };
    case "message.part.updated":
      return {
        type: "message.part.updated",
        part: normalizePartSessionId("opencode", oc.properties.part),
      };
    case "message.part.delta":
      return {
        type: "message.part.delta",
        sessionID: toCompositeSessionId(oc.properties.sessionID),
        messageID: oc.properties.messageID,
        partID: oc.properties.partID,
        field: oc.properties.field,
        delta: oc.properties.delta,
      };
    case "message.part.removed":
      return {
        type: "message.part.removed",
        sessionID: toCompositeSessionId(oc.properties.sessionID),
        messageID: oc.properties.messageID,
        partID: oc.properties.partID,
      };
    case "message.removed":
      return {
        type: "message.removed",
        sessionID: toCompositeSessionId(oc.properties.sessionID),
        messageID: oc.properties.messageID,
      };
    case "session.status":
      return {
        type: "session.status",
        sessionID: toCompositeSessionId(oc.properties.sessionID),
        status: oc.properties.status,
      };
    case "session.idle":
      return {
        type: "session.status",
        sessionID: toCompositeSessionId(oc.properties.sessionID),
        status: { type: "idle" },
      };
    case "permission.asked":
      return {
        type: "permission.requested",
        request: {
          ...oc.properties,
          sessionID: toCompositeSessionId(oc.properties.sessionID),
        },
      };
    case "permission.replied":
      return {
        type: "permission.cleared",
        sessionID: toCompositeSessionId((oc.properties as { sessionID: string }).sessionID),
      };
    case "question.asked":
      return {
        type: "question.requested",
        request: {
          ...oc.properties,
          sessionID: toCompositeSessionId(oc.properties.sessionID),
        },
      };
    case "question.replied":
    case "question.rejected":
      return {
        type: "question.cleared",
        sessionID: toCompositeSessionId((oc.properties as { sessionID: string }).sessionID),
      };
    case "session.error": {
      const errData = oc.properties.error;
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
          typeof oc.properties.sessionID === "string"
            ? toCompositeSessionId(oc.properties.sessionID)
            : undefined,
      };
    }
    default:
      return null;
  }
}
