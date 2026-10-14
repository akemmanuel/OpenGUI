import { Data, Effect, Schedule } from "effect";
import { runAbortable } from "../effect/run-abortable.ts";
import { DEFAULT_MODEL_DELIVERY, type ModelRequest } from "./transport.ts";

/** A provider answer that is safe to repeat; carries the value for the final attempt. */
class RetryableResult<T> extends Data.TaggedError("RetryableResult")<{ readonly value: T }> {}

/**
 * Exponential backoff from 500 ms, capped at `maxRetryDelayMs`, for at most
 * `maxRetries` repeats: the uniform delivery contract every adapter shares.
 */
export function providerRetrySchedule(delivery: ModelRequest["delivery"]) {
  const { maxRetries, maxRetryDelayMs } = delivery ?? DEFAULT_MODEL_DELIVERY;
  return Schedule.max([
    Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced(maxRetryDelayMs)]),
    Schedule.recurs(maxRetries),
  ]);
}

/**
 * Runs `attempt` and repeats it while `shouldRetry` says so, within the
 * request's delivery budget. When the budget runs out the last value is
 * returned for the caller to report. Rejections are never retried: a thrown
 * fetch may already have reached the provider. Aborting `signal` interrupts
 * the current attempt or backoff.
 */
export function retryProviderRequest<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  shouldRetry: (value: T) => boolean | Promise<boolean>,
  options: { delivery: ModelRequest["delivery"]; signal: AbortSignal },
): Promise<T> {
  return runAbortable(
    Effect.tryPromise({ try: attempt, catch: (error) => error }).pipe(
      Effect.flatMap((value) =>
        Effect.promise(async () => await shouldRetry(value)).pipe(
          Effect.flatMap((retry) =>
            retry ? Effect.fail(new RetryableResult({ value })) : Effect.succeed(value),
          ),
        ),
      ),
      Effect.retry({
        while: (error) => error instanceof RetryableResult,
        schedule: providerRetrySchedule(options.delivery),
      }),
      Effect.catch((error) =>
        error instanceof RetryableResult
          ? Effect.succeed((error as RetryableResult<T>).value)
          : Effect.fail(error),
      ),
    ),
    options.signal,
  );
}
