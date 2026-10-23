/**
 * Online snapshot of the Host SQLite databases for operator backups.
 *
 * Run inside the same container or sandbox as the server, for example:
 *   docker exec opengui node --experimental-strip-types scripts/backup-databases.ts
 *
 * SQLite coordinates WAL readers and writers through POSIX locks and the shared-memory
 * `-shm` index. Sandboxes such as gVisor do not share either with processes outside the
 * sandbox, so a connection opened from the host machine, even a read-only
 * `sqlite3 ... "SELECT ..."`, can checkpoint and delete the live `-wal` file while the
 * server keeps writing to it. Every later write is then lost when the server restarts.
 * Taking the snapshot from inside the sandbox keeps that coordination intact.
 *
 * Writes self-contained, integrity-checked copies without `-wal`/`-shm` files to
 * `$OPENGUI_DATA_DIR/backups/<UTC timestamp>/`, or to the directory given as argument.
 * Copy that directory off the machine with any file-level tool.
 */
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const HOST_DATABASE_FILENAMES = [
  "opengui-harness-v1.sqlite",
  "opengui-identity-v1.sqlite",
] as const;

function snapshotDirectoryName(now: Date) {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

export async function backupHostDatabases(dataDirectory: string, targetDirectory: string) {
  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  const written: string[] = [];
  for (const filename of HOST_DATABASE_FILENAMES) {
    const sourcePath = join(dataDirectory, filename);
    if (!existsSync(sourcePath)) continue;
    const targetPath = join(targetDirectory, filename);
    const pendingPath = `${targetPath}.pending`;
    rmSync(pendingPath, { force: true });

    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      await backup(source, pendingPath);
    } finally {
      source.close();
    }

    const snapshot = new DatabaseSync(pendingPath);
    try {
      // A standalone copy must not depend on WAL sidecar files when it is read later.
      snapshot.exec("PRAGMA journal_mode = DELETE");
      const result = snapshot.prepare("PRAGMA quick_check").get() as { quick_check: string };
      if (result.quick_check !== "ok") {
        throw new Error(`Snapshot of ${filename} failed the integrity check`);
      }
    } finally {
      snapshot.close();
    }
    chmodSync(pendingPath, 0o600);
    renameSync(pendingPath, targetPath);
    written.push(targetPath);
  }
  return written;
}

async function main() {
  const dataDirectory = resolve(
    process.env.OPENGUI_DATA_DIR || join(homedir(), ".config", "OpenGUI-web"),
  );
  const targetDirectory = process.argv[2]
    ? resolve(process.argv[2])
    : join(dataDirectory, "backups", snapshotDirectoryName(new Date()));
  const written = await backupHostDatabases(dataDirectory, targetDirectory);
  if (written.length === 0) {
    throw new Error(`No Host databases found in ${dataDirectory}`);
  }
  for (const path of written) console.info(`Snapshot written: ${path}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Database backup failed");
    process.exit(1);
  });
}
