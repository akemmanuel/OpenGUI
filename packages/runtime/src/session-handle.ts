import type { HarnessEvent } from "../../../src/agents/backend.ts";
import type { HarnessId } from "../../../src/agents/index.ts";
import {
  composeFrontendSessionId,
  parseFrontendSessionId,
} from "../../../src/lib/session-identity.ts";
import type { SelectedModel } from "../../../src/types/electron.d.ts";
import type { HarnessService } from "./harness-service.ts";
import {
  type AgentStreamHandler,
  filterStreamEventsForSession,
  liveSessionEventToAgentStreamEvents,
  streamEventMatchesSession,
} from "./agent-stream.ts";
import type { ManagedHarnessId } from "./harness-runtime.ts";
import type { LiveSessionEventHandler } from "./live-session-events/live-session-event.ts";
import { LiveSessionEventBus } from "./live-session-events/live-session-event-bus.ts";
import { harnessEventsToLiveSessionEvents } from "./live-session-events/harness-events-to-live.ts";
import { OpenGuiSdkError } from "./opengui-sdk-error.ts";
import type { SessionTranscripts } from "./session-transcripts.ts";
import { waitUntilIdleViaHarness } from "./wait-until-idle.ts";

/** Harness session summary (list/create); `id` is opaque for `open()`. */
export interface SessionSummary {
  id: string;
  title?: string;
  status?: string;
  directory?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SendOptions {
  model?: SelectedModel;
  agent?: string;
  variant?: string;
  /**
   * When the session is busy: `fail` throws SESSION_BUSY (default); `wait` polls until idle then retries once.
   * Not a prompt queue (ADR 0005).
   */
  whileBusy?: "fail" | "wait";
  waitTimeoutMs?: number;
}

export interface WaitUntilIdleOptions {
  timeoutMs?: number;
}

export interface MessagesOptions {
  limit?: number;
  before?: string | null;
}

/** Per-session SDK handle (ADR 0007). */
export interface SessionHandle {
  readonly id: string;
  readonly harnessId: HarnessId;
  readonly directory: string;
  send(text: string, options?: SendOptions): Promise<void>;
  abort(): Promise<void>;
  messages(options?: MessagesOptions): Promise<unknown>;
  onEvent(handler: LiveSessionEventHandler): () => void;
  onStream(handler: AgentStreamHandler): () => void;
  waitUntilIdle(options?: WaitUntilIdleOptions): Promise<void>;
  close(): void;
}

export interface SessionHandleDeps {
  harnessId: ManagedHarnessId;
  directory: string;
  sessionId: string;
  service: HarnessService;
  transcripts: SessionTranscripts;
  resolveSessionIds(sessionId: string): { rawId: string };
  getSessionStatus(
    directory: string,
    rawId: string,
  ): "idle" | "running" | "error" | "unknown" | undefined;
  markSessionRunning(directory: string, rawId: string): void;
  markSessionIdle?(directory: string, rawId: string): void;
  subscribeHarnessEvents(handler: (event: HarnessEvent) => void): () => void;
}

export function sessionIdFromCreateResult(harnessId: HarnessId, data: unknown): string {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record.id === "string" && record.id.length > 0) return record.id;
    if (typeof record.sessionId === "string" && record.sessionId.length > 0) {
      return composeFrontendSessionId(harnessId, record.sessionId);
    }
    if (record.session && typeof record.session === "object") {
      const session = record.session as Record<string, unknown>;
      if (typeof session.id === "string" && session.id.length > 0) return session.id;
    }
  }
  if (typeof data === "string" && data.length > 0) {
    return parseFrontendSessionId(data) ? data : composeFrontendSessionId(harnessId, data);
  }
  throw new OpenGuiSdkError(
    "BRIDGE_ERROR",
    `Harness ${harnessId} session:create returned no session id`,
  );
}

function wrapBridgeError(error: unknown): never {
  if (error instanceof OpenGuiSdkError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  throw new OpenGuiSdkError("BRIDGE_ERROR", message);
}

const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_SEND_WAIT_TIMEOUT_MS = 120_000;

export function createSessionHandle(deps: SessionHandleDeps): SessionHandle {
  const { harnessId, directory, sessionId, service, transcripts } = deps;
  const resolveSessionIds = (id: string) => deps.resolveSessionIds(id);
  const getSessionStatus = (dir: string, rawId: string) => deps.getSessionStatus(dir, rawId);
  const markSessionRunning = (dir: string, rawId: string) => deps.markSessionRunning(dir, rawId);
  const markSessionIdle = (dir: string, rawId: string) => deps.markSessionIdle?.(dir, rawId);
  const subscribeHarnessEvents = (handler: (event: HarnessEvent) => void) =>
    deps.subscribeHarnessEvents(handler);

  const streamHandlers = new Set<AgentStreamHandler>();
  const eventHandlers = new Set<LiveSessionEventHandler>();
  const liveBus = new LiveSessionEventBus();
  const liveBusOff = liveBus.onHarness(harnessId, (liveEvent) => {
    if (!streamEventMatchesSession(sessionId, liveEvent.scope.sessionId, harnessId)) return;
    for (const handler of eventHandlers) handler(liveEvent);
    const streamEvents = liveSessionEventToAgentStreamEvents(liveEvent);
    for (const streamEvent of filterStreamEventsForSession(streamEvents, sessionId, harnessId)) {
      for (const handler of streamHandlers) handler(streamEvent);
    }
  });
  let harnessUnsub: (() => void) | undefined;
  const waitIdleListeners = new Set<(event: HarnessEvent) => void>();

  const dispatchLive = (event: HarnessEvent) => {
    return harnessEventsToLiveSessionEvents({ directory, harnessId, event, bus: liveBus }).filter(
      (item) => streamEventMatchesSession(sessionId, item.scope.sessionId, harnessId),
    );
  };

  const ensureHarnessSubscription = () => {
    if (harnessUnsub) return;
    harnessUnsub = subscribeHarnessEvents((event) => {
      dispatchLive(event);
      for (const listener of waitIdleListeners) listener(event);
    });
  };

  const runtimeRef = (rawId: string) => {
    const now = new Date().toISOString();
    const status = getSessionStatus(directory, rawId) ?? "unknown";
    return {
      id: sessionId,
      rawId,
      directory,
      harnessId,
      title: "",
      status,
      createdAt: now,
      updatedAt: now,
    };
  };

  const waitUntilIdle = async (options?: WaitUntilIdleOptions): Promise<void> => {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const { rawId } = resolveSessionIds(sessionId);
    ensureHarnessSubscription();
    await waitUntilIdleViaHarness({
      timeoutMs,
      directory,
      harnessId,
      sessionId,
      getStatus: () => getSessionStatus(directory, rawId),
      onIdleObserved: () => markSessionIdle?.(directory, rawId),
      subscribeHarnessEvents,
      onHarnessIdle: (handler) => {
        waitIdleListeners.add(handler);
        return () => waitIdleListeners.delete(handler);
      },
    });
  };

  const sendOnce = async (text: string, options: SendOptions | undefined): Promise<void> => {
    const { rawId } = resolveSessionIds(sessionId);
    try {
      await service.promptSession({
        session: runtimeRef(rawId),
        scope: { directory, harnessId, sessionId: rawId },
        text,
        model: options?.model,
        agent: options?.agent,
        variant: options?.variant,
      });
    } catch (error) {
      wrapBridgeError(error);
    }
    markSessionRunning(directory, rawId);
  };

  return {
    id: sessionId,
    harnessId,
    directory,
    async send(text, options) {
      const whileBusy = options?.whileBusy ?? "fail";
      const { rawId } = resolveSessionIds(sessionId);
      const status = getSessionStatus(directory, rawId);
      if (status === "running") {
        if (whileBusy === "wait") {
          await waitUntilIdle({
            timeoutMs: options?.waitTimeoutMs ?? DEFAULT_SEND_WAIT_TIMEOUT_MS,
          });
          const afterWait = getSessionStatus(directory, rawId);
          if (afterWait === "running") {
            throw new OpenGuiSdkError(
              "SESSION_BUSY",
              "Session is still running after waitUntilIdle",
            );
          }
          await sendOnce(text, options);
          return;
        }
        throw new OpenGuiSdkError(
          "SESSION_BUSY",
          "Session is running; SDK does not queue prompts. Wait for idle, call abort(), or send({ whileBusy: 'wait' }).",
        );
      }
      await sendOnce(text, options);
    },
    async abort() {
      const { rawId } = resolveSessionIds(sessionId);
      try {
        await service.abortSession({
          session: { ...runtimeRef(rawId), status: "running" },
          scope: { directory, harnessId, sessionId: rawId },
        });
      } catch (error) {
        wrapBridgeError(error);
      }
      markSessionIdle?.(directory, rawId);
    },
    async messages(options) {
      const { rawId } = resolveSessionIds(sessionId);
      try {
        return await transcripts.readPage({
          scope: { directory, harnessId, sessionId },
          options: { limit: options?.limit, before: options?.before },
          fetchHarnessPage: () =>
            service.listMessages({
              session: runtimeRef(rawId),
              scope: { directory, harnessId, sessionId: rawId },
              options: { limit: options?.limit, before: options?.before },
            }),
        });
      } catch (error) {
        wrapBridgeError(error);
      }
    },
    onEvent(handler) {
      eventHandlers.add(handler);
      ensureHarnessSubscription();
      return () => {
        eventHandlers.delete(handler);
        if (eventHandlers.size === 0 && streamHandlers.size === 0 && harnessUnsub) {
          harnessUnsub();
          harnessUnsub = undefined;
        }
      };
    },
    onStream(handler) {
      streamHandlers.add(handler);
      ensureHarnessSubscription();
      return () => {
        streamHandlers.delete(handler);
        if (streamHandlers.size === 0 && eventHandlers.size === 0 && harnessUnsub) {
          harnessUnsub();
          harnessUnsub = undefined;
        }
      };
    },
    waitUntilIdle,
    close() {
      streamHandlers.clear();
      eventHandlers.clear();
      waitIdleListeners.clear();
      liveBusOff();
      if (harnessUnsub) {
        harnessUnsub();
        harnessUnsub = undefined;
      }
    },
  };
}
