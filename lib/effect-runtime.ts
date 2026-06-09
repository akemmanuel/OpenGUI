import { Effect, Schedule } from "effect";

export function runEffect<A, E>(effect: Effect.Effect<A, E, never>): Promise<A> {
  return Effect.runPromise(effect);
}

export function forkEffect<A, E>(effect: Effect.Effect<A, E, never>) {
  return Effect.runFork(effect);
}

export function tryPromiseEffect<A>(operation: (signal: AbortSignal) => PromiseLike<A>) {
  return Effect.tryPromise({
    try: operation,
    catch: (error) => error,
  });
}

export function sleepEffect(ms: number) {
  return Effect.sleep(ms);
}

export function timeoutEffect<A, E>(
  effect: Effect.Effect<A, E, never>,
  input: { timeoutMs: number; timeoutMessage: string | (() => string) },
) {
  return effect.pipe(
    Effect.timeoutFail({
      duration: input.timeoutMs,
      onTimeout: () =>
        new Error(
          typeof input.timeoutMessage === "function"
            ? input.timeoutMessage()
            : input.timeoutMessage,
        ),
    }),
  );
}

export function pollUntilEffect(input: {
  attempt: () => PromiseLike<boolean>;
  intervalMs: number;
  timeoutMs: number;
  timeoutMessage: string | (() => string);
}) {
  return timeoutEffect(
    tryPromiseEffect(async () => {
      const ready = await input.attempt();
      if (!ready) throw new Error("Condition not ready");
    }).pipe(Effect.retry(Schedule.spaced(input.intervalMs))),
    { timeoutMs: input.timeoutMs, timeoutMessage: input.timeoutMessage },
  );
}
