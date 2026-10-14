import { randomUUID } from "node:crypto";
import { constants, readFileSync, unlinkSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, utimes } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { Effect, Exit, Schema, Scope, Semaphore } from "effect";

export type DurableJsonFileSystem = {
  read(path: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  write(path: string, data: string, mode: number): Promise<void>;
  fileSync(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  directorySync(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
};

const unsupportedDirectorySyncErrors = new Set(["EISDIR", "EINVAL", "ENOTSUP", "EPERM"]);

export const durableJsonFileSystem: DurableJsonFileSystem = {
  read: (path) => readFile(path, "utf8"),
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  async write(path, data, mode) {
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    try {
      await file.writeFile(data, "utf8");
    } finally {
      await file.close();
    }
  },
  async fileSync(path) {
    const file = await open(path, "r+");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  },
  rename,
  async directorySync(path) {
    try {
      const directory = await open(path, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !unsupportedDirectorySyncErrors.has(code)) throw error;
    }
  },
  async unlink(path) {
    await unlink(path);
  },
};

/** The state file may already be replaced (`committed`) even though durability failed. */
export class DurableJsonCommitError extends Schema.TaggedError<DurableJsonCommitError>()(
  "DurableJsonCommitError",
  { message: Schema.String, cause: Schema.Defect(), committed: Schema.Boolean },
) {}

/** Another live process (or transaction) holds the state lock. */
export class DurableStateLockedError extends Schema.TaggedError<DurableStateLockedError>()(
  "DurableStateLockedError",
  { message: Schema.String, path: Schema.String },
) {}

/** Fail-closed state could not be parsed or validated. */
export class DurableStateMalformedError extends Schema.TaggedError<DurableStateMalformedError>()(
  "DurableStateMalformedError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export class DurableStateClosedError extends Schema.TaggedError<DurableStateClosedError>()(
  "DurableStateClosedError",
  { message: Schema.String },
) {}

export type DurableJsonTransaction<T> = {
  current(): T;
  replace(next: T): Promise<void>;
  update(update: (current: T) => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
};

function processIsAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** How often a held lock's mtime is refreshed, proving its holder is alive. */
const LOCK_HEARTBEAT_MS = 10_000;
/** A lock whose heartbeat is older than this has no live holder anywhere. */
const LOCK_STALE_AFTER_MS = 60_000;

/**
 * Locks held by this process, by path. Two transactions in one process still
 * conflict. Held locks are refreshed by a heartbeat and released on exit.
 */
const heldLocks = new Map<string, { owner: string; heartbeat: ReturnType<typeof setInterval> }>();

/**
 * Synchronously removes every lock this process still holds. `process.exit()`
 * (for example a shutdown deadline) skips Scope finalizers, so this runs on
 * exit to keep the next start from finding our lock.
 */
export function releaseHeldLocksSync() {
  for (const [path, { owner, heartbeat }] of heldLocks) {
    clearInterval(heartbeat);
    heldLocks.delete(path);
    try {
      if ((JSON.parse(readFileSync(path, "utf8")) as LockRecord).owner === owner) unlinkSync(path);
    } catch {
      // Best effort: the process is exiting.
    }
  }
}

let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", releaseHeldLocksSync);
}

type LockRecord = { pid?: number; owner?: string; hostname?: string };

/**
 * A lock is stale when its process is gone, or when it names this very process
 * without being held here: containers reuse small PIDs, so after an unclean stop
 * the next start sees "its own" PID in the lock. On the same hostname that is
 * certain. A recreated container gets a new hostname, but another live container
 * sharing the data directory could also have our PID, so a lock from another (or
 * unknown) hostname is only stale once its heartbeat has stopped.
 */
function lockIsStale(path: string, lock: LockRecord, heartbeatAgeMs: number) {
  const pid = lock.pid ?? 0;
  if (pid === process.pid && !heldLocks.has(path)) {
    return lock.hostname === hostname() || heartbeatAgeMs > LOCK_STALE_AFTER_MS;
  }
  return !processIsAlive(pid);
}

function lockInUseError(path: string, holder: LockRecord) {
  const by =
    typeof holder.pid === "number"
      ? ` by pid ${holder.pid}${holder.hostname ? ` on ${holder.hostname}` : ""}`
      : "";
  return new DurableStateLockedError({
    path,
    message:
      `Durable state is already in use${by}: ${path}. If that process or container is ` +
      "stopped, move the .lock file aside and start again.",
  });
}

const errnoCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

const writeLockFile = (path: string, owner: string) =>
  Effect.promise(async () => {
    const lock = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await lock.writeFile(
        JSON.stringify({ pid: process.pid, owner, hostname: hostname() }),
        "utf8",
      );
      await lock.sync();
    } finally {
      await lock.close();
    }
  });

function holdLock(path: string, owner: string, heartbeatMs: number) {
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(path, now, now).catch(() => undefined);
  }, heartbeatMs);
  // The heartbeat must never keep a process alive on its own.
  heartbeat.unref?.();
  heldLocks.set(path, { owner, heartbeat });
  installExitHook();
}

/** Creates the lock file, stealing it once if its holder is provably gone. */
const acquireLock = Effect.fnUntraced(function* (path: string, owner: string, heartbeatMs: number) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const created = yield* writeLockFile(path, owner).pipe(
      Effect.as(true),
      Effect.catchDefect((error) =>
        errnoCode(error) === "EEXIST" ? Effect.succeed(false) : Effect.die(error),
      ),
    );
    if (created) {
      holdLock(path, owner, heartbeatMs);
      return;
    }
    // A malformed lock is not stolen: another process may still be creating it.
    const holder = yield* Effect.promise(async () => ({
      record: JSON.parse(await readFile(path, "utf8")) as LockRecord,
      heartbeatAgeMs: Date.now() - (await stat(path)).mtimeMs,
    })).pipe(Effect.catchDefect(() => Effect.succeed(undefined)));
    if (!holder || !lockIsStale(path, holder.record, holder.heartbeatAgeMs))
      return yield* lockInUseError(path, holder?.record ?? {});
    yield* Effect.promise(() => unlink(path)).pipe(
      Effect.catchDefect((error) =>
        errnoCode(error) === "ENOENT" ? Effect.void : Effect.die(error),
      ),
    );
  }
  return yield* lockInUseError(path, {});
});

const releaseLock = (path: string, owner: string) =>
  Effect.promise(async () => {
    const held = heldLocks.get(path);
    if (held?.owner === owner) {
      clearInterval(held.heartbeat);
      heldLocks.delete(path);
    }
    try {
      const lock = JSON.parse(await readFile(path, "utf8")) as { owner?: string };
      if (lock.owner === owner) await unlink(path);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
  });

/**
 * Opens a locked JSON state file for the lifetime of the enclosing Scope.
 * Writes are serialized and published atomically (write, fsync, rename,
 * directory fsync); closing the Scope waits for pending writes, then releases
 * the lock.
 */
export const makeDurableJsonTransaction = Effect.fnUntraced(function* <T>(
  path: string,
  options: {
    fallback: T;
    validate(value: unknown): T;
    /** By default legacy callers recover invalid JSON with fallback. Security-sensitive
     * state can opt into failing closed while still creating a missing file. */
    failOnInvalid?: boolean;
    mode?: number;
    fileSystem?: Partial<DurableJsonFileSystem>;
    /** Lock heartbeat interval; tests shorten it. */
    lockHeartbeatMs?: number;
  },
) {
  const directory = dirname(path);
  const lockPath = `${path}.lock`;
  const owner = randomUUID();
  const fileSystem = { ...durableJsonFileSystem, ...options.fileSystem };
  yield* Effect.promise(() => fileSystem.mkdir(directory));
  yield* Effect.acquireRelease(
    acquireLock(lockPath, owner, options.lockHeartbeatMs ?? LOCK_HEARTBEAT_MS),
    () => releaseLock(lockPath, owner),
  );

  let state = yield* Effect.tryPromise({
    try: async () => options.validate(JSON.parse(await fileSystem.read(path))),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      options.failOnInvalid && errnoCode(error) !== "ENOENT"
        ? Effect.fail(
            new DurableStateMalformedError({
              message: `Durable JSON state is malformed: ${path}`,
              cause: error,
            }),
          )
        : Effect.succeed(structuredClone(options.fallback)),
    ),
  );

  const publish = (next: T) =>
    Effect.promise(async () => {
      const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
      let renamed = false;
      try {
        await fileSystem.write(
          temporaryPath,
          `${JSON.stringify(next, null, 2)}\n`,
          options.mode ?? 0o600,
        );
        await fileSystem.fileSync(temporaryPath);
        await fileSystem.rename(temporaryPath, path);
        renamed = true;
        state = structuredClone(next);
        await fileSystem.directorySync(directory);
      } catch (error) {
        if (!renamed) {
          await fileSystem.unlink(temporaryPath).catch(() => undefined);
          throw error;
        }
        throw new DurableJsonCommitError({
          message: "The state file was replaced, but directory durability could not be confirmed",
          cause: error,
          committed: true,
        });
      }
    });

  // One writer at a time; the finalizer below drains it before unlocking.
  const writer = yield* Semaphore.make(1);
  let closed = false;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    }).pipe(Effect.andThen(writer.withPermits(1)(Effect.void))),
  );
  const serialized = <A>(operation: Effect.Effect<A>) =>
    Effect.suspend(() =>
      closed
        ? Effect.die(
            new DurableStateClosedError({ message: "Durable state transaction is closed" }),
          )
        : writer.withPermits(1)(operation),
    );

  return {
    current: () => structuredClone(state),
    replace: (next: T) => serialized(publish(next)),
    update: (update: (current: T) => T | Promise<T>) =>
      serialized(
        Effect.promise(async () => await update(structuredClone(state))).pipe(
          Effect.tap(publish),
          Effect.map((next) => structuredClone(next)),
        ),
      ),
  };
});

export async function openDurableJsonTransaction<T>(
  path: string,
  options: Parameters<typeof makeDurableJsonTransaction<T>>[1],
): Promise<DurableJsonTransaction<T>> {
  const scope = await Effect.runPromise(Scope.make());
  const transaction = await Effect.runPromise(
    makeDurableJsonTransaction<T>(path, options).pipe(Scope.provide(scope)),
  ).catch(async (error: unknown) => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  });
  let closing: Promise<void> | undefined;
  return {
    current: transaction.current,
    replace: (next) => Effect.runPromise(transaction.replace(next)),
    update: (update) => Effect.runPromise(transaction.update(update)),
    close: () => (closing ??= Effect.runPromise(Scope.close(scope, Exit.void))),
  };
}
