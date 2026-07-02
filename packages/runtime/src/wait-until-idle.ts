import type { HarnessEvent } from "../../../src/agents/backend.ts";
import type { HarnessId } from "../../../src/agents/index.ts";
import { harnessEventToAdapterObservations } from "./live-session-events/live-session-event-compat.ts";
import { streamEventMatchesSession } from "./agent-stream.ts";
import { OpenGuiSdkError } from "./opengui-sdk-error.ts";

export function isWaitResolvedStatus(status: string | undefined): boolean {
  return status === "idle" || status === "error" || status === undefined || status === "unknown";
}

export function harnessEventSignalsSessionIdle(
  event: HarnessEvent,
  ctx: { directory: string; harnessId: HarnessId; sessionId: string },
): boolean {
  const observations = harnessEventToAdapterObservations({
    directory: ctx.directory,
    harnessId: ctx.harnessId,
    event,
  });
  return observations.some(
    (item) =>
      item.kind === "activity" &&
      item.state !== "running" &&
      streamEventMatchesSession(ctx.sessionId, item.scope.sessionId, ctx.harnessId),
  );
}

export interface WaitUntilIdleHarnessOptions {
  timeoutMs: number;
  directory: string;
  harnessId: HarnessId;
  sessionId: string;
  getStatus: () => string | undefined;
  onIdleObserved: () => void;
  subscribeHarnessEvents: (handler: (event: HarnessEvent) => void) => () => void;
  /** When set, reuse this listener instead of a second harness subscription. */
  onHarnessIdle?: (handler: (event: HarnessEvent) => void) => () => void;
}

export function waitUntilIdleViaHarness(options: WaitUntilIdleHarnessOptions): Promise<void> {
  const {
    timeoutMs,
    directory,
    harnessId,
    sessionId,
    getStatus,
    onIdleObserved,
    subscribeHarnessEvents,
    onHarnessIdle,
  } = options;

  const maybeResolveIdle = (): boolean => isWaitResolvedStatus(getStatus());
  if (maybeResolveIdle()) return Promise.resolve();

  const ctx = { directory, harnessId, sessionId };

  return new Promise<void>((resolve, reject) => {
    let harnessOff: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;

    const finish = () => {
      onIdleObserved();
      resolve();
    };

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (poll) clearInterval(poll);
      harnessOff?.();
    };

    timeout = setTimeout(() => {
      cleanup();
      reject(
        new OpenGuiSdkError("WAIT_TIMEOUT", `Session did not become idle within ${timeoutMs}ms`),
      );
    }, timeoutMs);

    const onHarnessEvent = (event: HarnessEvent) => {
      if (harnessEventSignalsSessionIdle(event, ctx) || maybeResolveIdle()) {
        cleanup();
        finish();
      }
    };

    harnessOff = onHarnessIdle
      ? onHarnessIdle(onHarnessEvent)
      : subscribeHarnessEvents(onHarnessEvent);

    poll = setInterval(() => {
      if (maybeResolveIdle()) {
        cleanup();
        finish();
      }
    }, 100);
  });
}
