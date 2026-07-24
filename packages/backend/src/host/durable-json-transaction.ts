import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
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

async function acquireLock(path: string, owner: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const lock = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, owner }), "utf8");
        await lock.sync();
      } finally {
        await lock.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const lock = JSON.parse(await readFile(path, "utf8")) as { pid?: number };
        stale = !(await processIsAlive(lock.pid ?? 0));
      } catch {
        // A malformed lock is not stolen: another process may still be creating it.
      }
      if (!stale) throw new Error(`Durable state is already in use: ${path}`);
      await unlink(path).catch((unlinkError) => {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      });
    }
  }
  throw new Error(`Durable state is already in use: ${path}`);
}

export async function openDurableJsonTransaction<T>(
  path: string,
  options: {
    fallback: T;
    validate(value: unknown): T;
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
  } catch {
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
      }
    },
  };
}
