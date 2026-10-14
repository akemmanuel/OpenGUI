import { Effect } from "effect";

export function runEffect<A, E>(effect: Effect.Effect<A, E, never>): Promise<A> {
  return Effect.runPromise(effect);
}

export function tryPromiseEffect<A>(operation: (signal: AbortSignal) => PromiseLike<A>) {
  return Effect.tryPromise({
    try: operation,
    catch: (error) => error,
  });
}

export function timeoutEffect<A, E>(
  effect: Effect.Effect<A, E, never>,
  input: { timeoutMs: number; timeoutMessage: string | (() => string) },
) {
  return effect.pipe(
    Effect.timeoutOrElse({
      duration: input.timeoutMs,
      orElse: () =>
        Effect.fail(
          new Error(
            typeof input.timeoutMessage === "function"
              ? input.timeoutMessage()
              : input.timeoutMessage,
          ),
        ),
    }),
  );
}
