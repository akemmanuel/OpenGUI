import type { HarnessId } from "@opengui/protocol";
import type { HarnessEvent } from "@opengui/runtime";
import { composeFrontendSessionId } from "../../../../src/lib/session-identity.ts";
import { publishLiveSessionHarnessEvent } from "../../../../server/live-session-event-publish.ts";
import { publishProjectedTranscriptEvent } from "../../../../server/projected-transcript-publish.ts";
import {
  ensureSessionFromRuntime,
  resolveTranscriptScopeForBridgeEvent,
  type BackendServiceContext,
  type SessionRecord,
} from "../../../../server/services/index.ts";
import {
  getHarnessIdFromBridgeChannel,
  normalizeBridgeEvent,
  isTranscriptProjectionInput,
  transcriptSessionId,
  type InProcessIpcSender,
  type SessionTranscriptScope,
} from "@opengui/runtime";
import type { SseClient } from "./sse.ts";

function getCanonicalEventType(event: HarnessEvent): string {
  switch (event.type) {
    case "connection.status":
      return "project.connection.status";
    case "session.error":
      return "runtime.error";
    default:
      return event.type;
  }
}

function getBridgeEventRefs(event: HarnessEvent): {
  directory?: string;
  sessionId?: string;
  harnessId?: string;
} {
  switch (event.type) {
    case "connection.status":
      return { directory: event.directory };
    case "session.created":
    case "session.updated":
      return {
        directory: event.directory,
        sessionId: event.session.id,
      };
    case "session.replaced":
      return {
        directory: event.directory,
        sessionId: event.newId,
      };
    case "session.deleted":
      return {
        directory: event.directory,
        sessionId: event.sessionId,
      };
    case "message.updated":
      return { sessionId: event.message.sessionID };
    case "message.replaced":
      return { sessionId: event.sessionID };
    case "message.part.updated":
      return { sessionId: "sessionID" in event.part ? event.part.sessionID : undefined };
    case "message.part.delta":
    case "message.part.removed":
    case "message.removed":
    case "session.status":
    case "permission.cleared":
    case "question.cleared":
      return { sessionId: event.sessionID };
    case "permission.requested":
      return { sessionId: event.request.sessionID };
    case "question.requested":
      return { sessionId: event.request.sessionID };
    case "session.error":
      return { sessionId: event.sessionID };
    default:
      return {};
  }
}

function bridgeDirectoryHintFromRaw(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const directory = (data as { directory?: unknown }).directory;
  return typeof directory === "string" && directory.trim() ? directory.trim() : undefined;
}

async function ensureTranscriptProjectionHydrated(
  services: BackendServiceContext,
  input: { scope: SessionTranscriptScope; session: SessionRecord },
) {
  if (services.transcripts.isHydrated(input.scope)) return;
  await services.transcripts.readPage({
    scope: input.scope,
    fetchHarnessPage: () =>
      services.harnesses.listMessages({
        session: input.session,
        scope: {
          directory: input.scope.directory,
          harnessId: input.session.harnessId,
          sessionId: input.scope.sessionId,
        },
        options: {},
      }),
  });
}

async function applyCanonicalEventSideEffects(
  services: BackendServiceContext,
  harnessId: HarnessId,
  event: HarnessEvent,
) {
  try {
    if ((event.type === "session.created" || event.type === "session.updated") && event.session) {
      await ensureSessionFromRuntime({
        sessions: services.sessions,
        runtimeSession: event.session,
        directory: event.directory,
        harnessId,
      });
      return;
    }

    if (event.type === "session.replaced") {
      const oldWire = composeFrontendSessionId(harnessId, event.oldId);
      const newWire = composeFrontendSessionId(harnessId, event.newId);
      await services.storage.migratePromptQueueSessionId(oldWire, newWire);
      await services.sessions.deleteSession(oldWire, {
        directory: event.directory,
        harnessId,
      });
      await ensureSessionFromRuntime({
        sessions: services.sessions,
        runtimeSession: event.session,
        directory: event.directory,
        harnessId,
      });
      return;
    }

    if (event.type === "session.status") {
      const status =
        event.status?.type === "busy" || event.status?.type === "running"
          ? "running"
          : event.status?.type === "idle"
            ? "idle"
            : event.status?.type === "error"
              ? "error"
              : undefined;
      if (!status) return;
      await services.sessions.updateSession(event.sessionID, { status }, { harnessId });
      return;
    }

    if (event.type === "session.error") {
      if (!event.sessionID) return;
      await services.sessions.updateSession(event.sessionID, { status: "error" }, { harnessId });
    }
  } catch {
    // Keep SSE delivery independent from the REST session-index cache.
  }
}

export type BridgeBroadcastState = {
  rawClients: Set<SseClient>;
  canonicalClients: Set<SseClient>;
  broadcast: (channel: string, data: unknown) => void;
  attachCanonicalEventFanout: (services: BackendServiceContext) => void;
};

export function createBridgeBroadcast(input: {
  servicesReady: Promise<BackendServiceContext>;
  resolveSafeDirectory: (inputPath: string | null) => Promise<string>;
  sender: InProcessIpcSender;
}): BridgeBroadcastState {
  const rawClients = new Set<SseClient>();
  const canonicalClients = new Set<SseClient>();

  const broadcast = (channel: string, data: unknown) => {
    const payload = JSON.stringify({ channel, data });
    for (const client of rawClients)
      void client.send(payload).catch(() => rawClients.delete(client));

    const harnessId = getHarnessIdFromBridgeChannel(channel);
    if (!harnessId) return;
    let normalizedEvent: ReturnType<typeof normalizeBridgeEvent>;
    try {
      normalizedEvent = normalizeBridgeEvent({ harnessId, event: data });
    } catch (error) {
      const eventType =
        typeof data === "object" && data !== null && "type" in data
          ? String((data as { type?: unknown }).type)
          : "unknown";
      console.error("[bridge] failed to normalize harness event", { harnessId, eventType, error });
      return;
    }
    if (!normalizedEvent) return;

    void input.servicesReady.then(async (services) => {
      await applyCanonicalEventSideEffects(services, harnessId, normalizedEvent);

      if (!isTranscriptProjectionInput(normalizedEvent)) {
        services.events.publish(getCanonicalEventType(normalizedEvent), normalizedEvent, {
          ...getBridgeEventRefs(normalizedEvent),
          harnessId,
        });
        return;
      }

      const transcriptContext = await resolveTranscriptScopeForBridgeEvent(
        services,
        harnessId,
        normalizedEvent,
        input.resolveSafeDirectory,
        bridgeDirectoryHintFromRaw(data),
      );
      if (!transcriptContext) {
        const bridgeDirectory = bridgeDirectoryHintFromRaw(data);
        services.events.publish(getCanonicalEventType(normalizedEvent), normalizedEvent, {
          ...getBridgeEventRefs(normalizedEvent),
          harnessId,
          ...(bridgeDirectory ? { directory: bridgeDirectory } : {}),
        });
        if (normalizedEvent.type !== "session.status") {
          console.warn("[transcript] published canonical fallback for unscoped transcript event", {
            harnessId,
            type: normalizedEvent.type,
            sessionId: transcriptSessionId(normalizedEvent),
          });
        }
        return;
      }

      const livePublished = publishLiveSessionHarnessEvent(services, {
        directory: transcriptContext.scope.directory,
        harnessId,
        event: normalizedEvent,
      });

      if (
        normalizedEvent.type === "session.status" &&
        (livePublished.length === 0 || normalizedEvent.status?.type === "retry")
      ) {
        services.events.publish(getCanonicalEventType(normalizedEvent), normalizedEvent, {
          ...getBridgeEventRefs(normalizedEvent),
          harnessId,
          directory: transcriptContext.scope.directory,
        });
      }

      try {
        await ensureTranscriptProjectionHydrated(services, transcriptContext);
      } catch (error) {
        console.warn("[transcript] failed to hydrate projection before live event", {
          harnessId,
          type: normalizedEvent.type,
          sessionId: transcriptSessionId(normalizedEvent),
          error,
        });
      }

      for (const projected of services.transcripts.ingest({
        scope: transcriptContext.scope,
        events: livePublished,
      })) {
        publishProjectedTranscriptEvent(services, projected);
      }
    });
  };

  const attachCanonicalEventFanout = (services: BackendServiceContext) => {
    services.events.subscribe((event) => {
      const payload = JSON.stringify(event);
      for (const client of canonicalClients) {
        void client.send(payload, event.id).catch(() => canonicalClients.delete(client));
      }
    });
  };

  return { rawClients, canonicalClients, broadcast, attachCanonicalEventFanout };
}
