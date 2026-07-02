/** Milliseconds to wait after aborting an SSE reader before opening the next stream. */
export const OPENCODE_SSE_ABORT_SETTLE_MS = 100;

export async function abortOpenCodeSseBeforeRestart(
  abortController: AbortController | null | undefined,
  settleMs: number = OPENCODE_SSE_ABORT_SETTLE_MS,
): Promise<void> {
  abortController?.abort();
  if (settleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }
}

export interface OpenCodeSseGenerationGate {
  streamGeneration: number;
  expectedGeneration: number;
  lifecycle: number;
  currentLifecycle: number;
  aborted: boolean;
}

export function shouldStopOpenCodeSseRead(gate: OpenCodeSseGenerationGate): boolean {
  return (
    gate.aborted ||
    gate.streamGeneration !== gate.expectedGeneration ||
    gate.lifecycle !== gate.currentLifecycle
  );
}
