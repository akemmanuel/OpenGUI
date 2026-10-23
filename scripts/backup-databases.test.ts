import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { backupHostDatabases, HOST_DATABASE_FILENAMES } from "./backup-databases.ts";

const directories: string[] = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "opengui-backup-test-"));
  directories.push(directory);
  return directory;
}

/** Opens a database like the running Host: WAL mode, with commits still only in the WAL. */
function openLiveDatabase(path: string) {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE entries (value TEXT NOT NULL);
  `);
  database.prepare("INSERT INTO entries (value) VALUES (?)").run("before-backup");
  return database;
}

function readValues(path: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return (
      database.prepare("SELECT value FROM entries ORDER BY rowid").all() as { value: string }[]
    ).map((row) => row.value);
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Host database backup", () => {
  test("snapshots WAL-only commits while the live connection keeps its WAL", async () => {
    const dataDirectory = temporaryDirectory();
    const targetDirectory = join(temporaryDirectory(), "snapshot");
    const live = HOST_DATABASE_FILENAMES.map((filename) => ({
      filename,
      database: openLiveDatabase(join(dataDirectory, filename)),
    }));
    for (const filename of HOST_DATABASE_FILENAMES) {
      expect(statSync(join(dataDirectory, `${filename}-wal`)).size).toBeGreaterThan(0);
    }

    const written = await backupHostDatabases(dataDirectory, targetDirectory);

    expect(written).toEqual(
      HOST_DATABASE_FILENAMES.map((filename) => join(targetDirectory, filename)),
    );
    expect(readdirSync(targetDirectory).sort()).toEqual([...HOST_DATABASE_FILENAMES].sort());
    for (const path of written) {
      expect(readValues(path)).toEqual(["before-backup"]);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const snapshot = new DatabaseSync(path, { readOnly: true });
      expect(snapshot.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
      snapshot.close();
    }

    // The backup must leave the live WAL in place, so later commits still survive a restart.
    for (const { filename, database } of live) {
      expect(existsSync(join(dataDirectory, `${filename}-wal`))).toBe(true);
      database.prepare("INSERT INTO entries (value) VALUES (?)").run("after-backup");
      database.close();
      expect(readValues(join(dataDirectory, filename))).toEqual(["before-backup", "after-backup"]);
    }
  });

  test("skips databases that do not exist yet", async () => {
    const dataDirectory = temporaryDirectory();
    const targetDirectory = join(temporaryDirectory(), "snapshot");
    openLiveDatabase(join(dataDirectory, "opengui-identity-v1.sqlite")).close();

    const written = await backupHostDatabases(dataDirectory, targetDirectory);

    expect(written).toEqual([join(targetDirectory, "opengui-identity-v1.sqlite")]);
  });
});
