import { Effect } from "effect";

function abortReason(signal: AbortSignal) {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/**
 * Promise boundary for cancellable effects. Aborting `signal` interrupts the
 * fiber (running its finalizers) and rejects with the signal's own reason, so
 * callers keep seeing the same `AbortError` a plain `fetch` would throw.
 */
export async function runAbortable<A, E>(
  effect: Effect.Effect<A, E>,
  signal: AbortSignal,
): Promise<A> {
  if (signal.aborted) throw abortReason(signal);
  try {
    return await Effect.runPromise(effect, { signal });
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    throw error;
  }
}
