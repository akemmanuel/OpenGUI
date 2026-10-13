import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

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

export class DurableJsonCommitError extends Error {
  readonly committed: boolean;
  override readonly cause: unknown;

  constructor(message: string, cause: unknown, committed: boolean) {
    super(message);
    this.cause = cause;
    this.committed = committed;
  }
}

export type DurableJsonTransaction<T> = {
  current(): T;
  replace(next: T): Promise<void>;
  update(update: (current: T) => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
};

async function processIsAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Lock paths held by this process. Two transactions in one process still conflict. */
const heldLocks = new Set<string>();

type LockRecord = { pid?: number; owner?: string; hostname?: string };

/**
 * A lock is stale when its process is gone, or when it names this very process
 * on this very machine/container without being held here: containers reuse small
 * PIDs, so after an unclean stop the next start sees "its own" PID in the lock.
 * Locks from another hostname (another container sharing the data directory)
 * are only stale when their PID is not alive here; never steal a live one.
 */
async function lockIsStale(path: string, lock: LockRecord) {
  const pid = lock.pid ?? 0;
  if (
    pid === process.pid &&
    lock.hostname !== undefined &&
    lock.hostname === hostname() &&
    !heldLocks.has(path)
  )
    return true;
  return !(await processIsAlive(pid));
}

async function acquireLock(path: string, owner: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const lock = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await lock.writeFile(
          JSON.stringify({ pid: process.pid, owner, hostname: hostname() }),
          "utf8",
        );
        await lock.sync();
      } finally {
        await lock.close();
      }
      heldLocks.add(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      let holder: LockRecord = {};
      try {
        holder = JSON.parse(await readFile(path, "utf8")) as LockRecord;
        stale = await lockIsStale(path, holder);
      } catch {
        // A malformed lock is not stolen: another process may still be creating it.
      }
      if (!stale) throw lockInUseError(path, holder);
      await unlink(path).catch((unlinkError) => {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      });
    }
  }
  throw lockInUseError(path, {});
}

function lockInUseError(path: string, holder: LockRecord) {
  const by =
    typeof holder.pid === "number"
      ? ` by pid ${holder.pid}${holder.hostname ? ` on ${holder.hostname}` : ""}`
      : "";
  return new Error(
    `Durable state is already in use${by}: ${path}. If that process or container is ` +
      "stopped, move the .lock file aside and start again.",
  );
}

export async function openDurableJsonTransaction<T>(
  path: string,
  options: {
    fallback: T;
    validate(value: unknown): T;
    /** By default legacy callers recover invalid JSON with fallback. Security-sensitive
     * state can opt into failing closed while still creating a missing file. */
    failOnInvalid?: boolean;
    mode?: number;
    fileSystem?: Partial<DurableJsonFileSystem>;
  },
): Promise<DurableJsonTransaction<T>> {
  const directory = dirname(path);
  const lockPath = `${path}.lock`;
  const owner = randomUUID();
  const fileSystem = { ...durableJsonFileSystem, ...options.fileSystem };
  await fileSystem.mkdir(directory);
  await acquireLock(lockPath, owner);
  let state: T;
  try {
    state = options.validate(JSON.parse(await fileSystem.read(path)));
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (options.failOnInvalid && !missing) {
      await unlink(lockPath).catch(() => undefined);
      heldLocks.delete(lockPath);
      throw new Error(`Durable JSON state is malformed: ${path}`, { cause: error });
    }
    state = structuredClone(options.fallback);
  }
  let queue = Promise.resolve();
  let closed = false;

  async function publish(next: T) {
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
      throw new DurableJsonCommitError(
        "The state file was replaced, but directory durability could not be confirmed",
        error,
        true,
      );
    }
  }

  function enqueue<R>(operation: () => Promise<R>) {
    if (closed) return Promise.reject(new Error("Durable state transaction is closed"));
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    current: () => structuredClone(state),
    replace: (next) => enqueue(() => publish(next)),
    update: (update) =>
      enqueue(async () => {
        const next = await update(structuredClone(state));
        await publish(next);
        return structuredClone(next);
      }),
    async close() {
      if (closed) return;
      closed = true;
      await queue;
      try {
        const lock = JSON.parse(await readFile(lockPath, "utf8")) as { owner?: string };
        if (lock.owner === owner) await unlink(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      } finally {
        heldLocks.delete(lockPath);
      }
    },
  };
}
