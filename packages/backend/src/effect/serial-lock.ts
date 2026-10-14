import { Effect, Semaphore } from "effect";

/** Runs async tasks one at a time, in arrival order. */
export class SerialLock {
  readonly #semaphore = Semaphore.makeUnsafe(1);

  run<A>(task: () => Promise<A>): Promise<A> {
    return Effect.runPromise(this.#semaphore.withPermits(1)(Effect.promise(task)));
  }

  /** Resolves once every task queued before this call has finished. */
  idle(): Promise<void> {
    return Effect.runPromise(this.#semaphore.withPermits(1)(Effect.void));
  }
}

/** One {@link SerialLock} per key; idle keys are dropped so the map stays bounded. */
export class KeyedSerialLock {
  readonly #locks = new Map<string, { lock: SerialLock; users: number }>();

  async run<A>(key: string, task: () => Promise<A>): Promise<A> {
    let entry = this.#locks.get(key);
    if (!entry) {
      entry = { lock: new SerialLock(), users: 0 };
      this.#locks.set(key, entry);
    }
    entry.users += 1;
    try {
      return await entry.lock.run(task);
    } finally {
      entry.users -= 1;
      if (entry.users === 0 && this.#locks.get(key) === entry) this.#locks.delete(key);
    }
  }

  /** Resolves once tasks queued for `key` before this call have finished. */
  async idle(key: string): Promise<void> {
    await this.#locks.get(key)?.lock.idle();
  }

  clear() {
    this.#locks.clear();
  }
}
