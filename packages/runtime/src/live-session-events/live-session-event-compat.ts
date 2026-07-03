import type { HarnessEvent } from "../../../../src/agents/backend.ts";
import type { HarnessId } from "../../../../src/agents/index.ts";
import type { AdapterObservation } from "./adapter-observation.ts";
import type { LiveSessionScope } from "./live-session-event.ts";
import { toLiveSessionScopeSessionId } from "./live-session-scope.ts";

export function harnessEventToAdapterObservations(input: {
  directory: string;
  harnessId: HarnessId;
  event: HarnessEvent;
}): AdapterObservation[] {
  const { directory, harnessId, event } = input;
  const source = { harnessId, nativeType: event.type };
  const scopeFor = (sessionId?: string): LiveSessionScope | null =>
    sessionId
      ? { directory, harnessId, sessionId: toLiveSessionScopeSessionId(harnessId, sessionId) }
      : null;
  switch (event.type) {
    case "session.status": {
      const scope = scopeFor(event.sessionID);
      if (!scope) return [];
      const status = event.status?.type;
      const state =
        status === "busy" || status === "running"
          ? "running"
          : status === "error"
            ? "error"
            : status === "idle"
              ? "idle"
              : undefined;
      return state ? [{ kind: "activity", scope, state, source }] : [];
    }
    case "session.error": {
      const scope = scopeFor(event.sessionID);
      return scope
        ? [
            { kind: "error", scope, message: event.error, source },
            { kind: "activity", scope, state: "error", source },
          ]
        : [];
    }
    case "message.updated": {
      const scope = scopeFor(event.message.sessionID);
      return scope ? [{ kind: "message.snapshot", scope, message: event.message, source }] : [];
    }
    case "message.replaced": {
      const scope = scopeFor(event.sessionID);
      if (!scope) return [];
      return [
        {
          kind: "transcript.replaced",
          scope,
          reason: "harness-replaced-message",
          oldMessageId: event.oldId,
          newMessageId: event.message.id,
          source,
        },
        { kind: "message.snapshot", scope, message: event.message, source },
        ...event.parts.map((part) =>
          part.type === "tool"
            ? ({
                kind: "tool.snapshot",
                scope,
                messageId: event.message.id,
                part,
                source,
              } as AdapterObservation)
            : ({
                kind: "part.snapshot",
                scope,
                messageId: event.message.id,
                part,
                source,
              } as AdapterObservation),
        ),
      ];
    }
    case "message.part.delta": {
      const scope = scopeFor(event.sessionID);
      if (!scope || !event.delta) return [];
      const field = event.field?.toLowerCase() ?? "text";
      const partKind = field.includes("reason") || field === "thinking" ? "thinking" : "text";
      return [
        {
          kind: "part.delta",
          scope,
          messageId: event.messageID,
          partId: event.partID,
          partKind,
          text: event.delta,
          source,
        },
      ];
    }
    case "message.part.updated": {
      const part = event.part;
      const scope = scopeFor(part.sessionID);
      if (!scope || !part.messageID) return [];
      return [
        part.type === "tool"
          ? { kind: "tool.snapshot", scope, messageId: part.messageID, part, source }
          : { kind: "part.snapshot", scope, messageId: part.messageID, part, source },
      ];
    }
    case "message.part.removed": {
      const scope = scopeFor(event.sessionID);
      if (!scope) return [];
      return [
        {
          kind: "part.removed",
          scope,
          messageId: event.messageID,
          partId: event.partID,
          source,
        },
      ];
    }
    case "message.removed": {
      const scope = scopeFor(event.sessionID);
      if (!scope) return [];
      return [
        {
          kind: "message.removed",
          scope,
          messageId: event.messageID,
          source,
        },
      ];
    }
    default:
      return [];
  }
}
