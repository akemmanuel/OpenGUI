/**
 * Runs async tasks one at a time, strictly in arrival order.
 *
 * Deliberately a promise chain rather than an Effect `Semaphore`: the
 * semaphore wakes waiters a tick after release, so a task arriving in that
 * gap overtakes queued ones. Prompt admission relies on arrival order.
 */
export class SerialLock {
  #tail: Promise<void> = Promise.resolve();

  run<A>(task: () => Promise<A>): Promise<A> {
    const result = this.#tail.then(task);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Resolves once every task queued before this call has finished. */
  idle(): Promise<void> {
    return this.#tail;
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
