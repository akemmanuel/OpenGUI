import {
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ActiveSessionTranscriptStore } from "@/features/session-transcript/active-session-transcript-store";
import type { HostEvent, OpenGuiHostClient } from "@/protocol/host-types";
import {
  applyHostTranscriptEvent,
  projectHostTranscriptStream,
  type HostTranscriptStream,
} from "@/protocol/host-transcript";
import { notifyUnknownError } from "@/lib/notify";

const TERMINAL_ENTRY_KINDS = new Set([
  "run_completed",
  "run_failed",
  "run_aborted",
  "run_interrupted",
]);

export function isTerminalHostEvent(hostEvent: HostEvent): boolean {
  return (
    hostEvent.event.type === "entry_appended" &&
    TERMINAL_ENTRY_KINDS.has(hostEvent.event.entry.kind)
  );
}

export function reduceBusySessionIds(current: Set<string>, hostEvent: HostEvent): Set<string> {
  const startsRun =
    hostEvent.event.type === "assistant_delta" ||
    (hostEvent.event.type === "entry_appended" && hostEvent.event.entry.kind === "run_started");
  const terminal = isTerminalHostEvent(hostEvent);
  if ((!startsRun && !terminal) || (startsRun && current.has(hostEvent.sessionId))) return current;
  if (terminal && !current.has(hostEvent.sessionId)) return current;

  const next = new Set(current);
  if (startsRun) next.add(hostEvent.sessionId);
  else next.delete(hostEvent.sessionId);
  return next;
}

export interface HostEventDispatcherDependencies {
  activeStreamRef: MutableRefObject<HostTranscriptStream | null>;
  setActiveSnapshot: (snapshot: HostTranscriptStream["snapshot"]) => void;
  setBusySessionIds: Dispatch<SetStateAction<Set<string>>>;
  transcriptStore: ActiveSessionTranscriptStore;
  refreshSessions: () => Promise<void>;
  onFollowUpDispatched?: (sessionId: string, followUpId: string) => void;
  /** Fires when the live model part ends (text committed or tool calls begin). */
  onModelPartEnded?: (sessionId: string) => void;
}

function isModelPartEndEvent(hostEvent: HostEvent): boolean {
  return (
    hostEvent.event.type === "entry_appended" &&
    (hostEvent.event.entry.kind === "assistant_message" ||
      hostEvent.event.entry.kind === "tool_call")
  );
}

/** Applies each event synchronously so deltas retain the Host's delivery order. */
export function createHostEventDispatcher({
  activeStreamRef,
  setActiveSnapshot,
  setBusySessionIds,
  transcriptStore,
  refreshSessions,
  onFollowUpDispatched,
  onModelPartEnded,
}: HostEventDispatcherDependencies): (hostEvent: HostEvent) => void {
  return (hostEvent) => {
    const terminal = isTerminalHostEvent(hostEvent);
    if (
      hostEvent.event.type === "entry_appended" &&
      hostEvent.event.entry.kind === "user_message" &&
      typeof hostEvent.event.entry.payload.followUpId === "string"
    ) {
      onFollowUpDispatched?.(hostEvent.sessionId, hostEvent.event.entry.payload.followUpId);
    }
    setBusySessionIds((current) => reduceBusySessionIds(current, hostEvent));

    const stream = activeStreamRef.current;
    if (stream?.snapshot.id === hostEvent.sessionId) {
      const nextStream = applyHostTranscriptEvent(stream, hostEvent);
      activeStreamRef.current = nextStream;
      setActiveSnapshot(nextStream.snapshot);
      transcriptStore.dispatch({
        type: "page.loaded",
        scope: {
          directory: nextStream.snapshot.projectDirectory,
          sessionId: hostEvent.sessionId,
        },
        phase: "initial",
        messages: projectHostTranscriptStream(nextStream),
        hasMore: false,
        nextCursor: null,
      });
    }

    if (isModelPartEndEvent(hostEvent)) onModelPartEnded?.(hostEvent.sessionId);
    if (terminal) void refreshSessions().catch(notifyUnknownError);
  };
}

interface UseHostEventStreamOptions extends HostEventDispatcherDependencies {
  host: OpenGuiHostClient | null;
  activeSessionId: string | null;
  activeSessionIdRef: MutableRefObject<string | null>;
  hydrateTranscript: (sessionId: string) => Promise<void>;
}

export function hostEventSubscriptionSession(activeSessionId: string | null) {
  return activeSessionId ?? undefined;
}

export function createHostReconnectHandler({
  activeSessionIdRef,
  hydrateTranscript,
}: Pick<UseHostEventStreamOptions, "activeSessionIdRef" | "hydrateTranscript">) {
  let hasConnected = false;
  return () => {
    if (!hasConnected) {
      hasConnected = true;
      return;
    }
    const sessionId = activeSessionIdRef.current;
    if (sessionId) void hydrateTranscript(sessionId).catch(notifyUnknownError);
  };
}

/** Owns subscription lifetime and rehydrates after every reconnect except initial readiness. */
export function useHostEventStream(options: UseHostEventStreamOptions): void {
  const onFollowUpDispatchedRef = useRef(options.onFollowUpDispatched);
  onFollowUpDispatchedRef.current = options.onFollowUpDispatched;

  const onModelPartEndedRef = useRef(options.onModelPartEnded);
  onModelPartEndedRef.current = options.onModelPartEnded;

  useEffect(() => {
    if (!options.host) return;
    const dispatchEvent = createHostEventDispatcher({
      ...options,
      onFollowUpDispatched: (sessionId, followUpId) =>
        onFollowUpDispatchedRef.current?.(sessionId, followUpId),
      onModelPartEnded: (sessionId) => onModelPartEndedRef.current?.(sessionId),
    });
    return options.host.subscribe(
      dispatchEvent,
      hostEventSubscriptionSession(options.activeSessionId),
      createHostReconnectHandler(options),
    );
  }, [
    options.host,
    options.activeSessionId,
    options.hydrateTranscript,
    options.refreshSessions,
    options.transcriptStore,
    options.activeSessionIdRef,
    options.activeStreamRef,
    options.setActiveSnapshot,
    options.setBusySessionIds,
  ]);
}
