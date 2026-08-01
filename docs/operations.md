# Host operations, security, and recovery

## Data and privacy

OpenGUI does not include a product analytics or telemetry service. Prompts, model output, tool
results, Accounts, grants, and credentials stay on the configured Host except for requests sent to
the model or MCP endpoints an operator configures. Tool calls can read and transmit Host-accessible
data, so only configure trusted endpoints and grant Projects deliberately.

Host state lives under `OPENGUI_DATA_DIR`. The principal databases are
`opengui-harness-v1.sqlite` (Sessions) and `opengui-identity-v1.sqlite` (Accounts and access). SQLite
uses WAL mode, so a live database may also have `-wal` and `-shm` files.

Provider and MCP secrets are excluded from Session entries and frontend persistence. Remote Host
secrets currently live in Host state protected by owner-only file permissions; they are not
application-encrypted. Protect the data directory as a secret, encrypt its disk/volume, restrict
backups, and inject any deployment encryption key through the platform secret manager—not through
Sessions or Project files. OS-backed Desktop secret custody and deployment-managed Remote Host
encryption remain required before a stable production release.

## Backup and restore

For a cold, consistent backup:

1. stop OpenGUI and confirm no Host process uses the data directory;
2. archive the complete `OPENGUI_DATA_DIR`, including SQLite sidecar files;
3. back up Project directories separately;
4. record the OpenGUI image/application version and checksum with the backup.

Restore into an empty directory with the same owner and mode, then start the same OpenGUI version.
Check `/api/health`, owner login, Session listing, and a read-only transcript before allowing Runs.
Upgrade only after a successful restore rehearsal; migrations run on Host startup and must never be
downgraded in place.

For an online backup, use SQLite's backup API or `VACUUM INTO` from an operator-controlled process;
copying only the main database while WAL writes continue is unsafe. Schedule WAL checkpoints during
quiet periods and monitor disk growth. Never delete `-wal`/`-shm` files while the Host is running.

## Corruption and rollback

If SQLite reports malformed data or migration failure, stop the Host and preserve the complete
directory for diagnosis. Do not run destructive repair against the only copy. Verify a copy with
`PRAGMA integrity_check`; restore the most recent verified backup when it fails. If it passes,
retain logs and the exact application version before retrying. Rollback means restoring both the
previous application/image and its pre-upgrade data backup.

Legacy external-Harness Session files and queued prompts are never read or dispatched by the
first-party Host. They remain untouched in their old locations; archive or remove them only through
an explicit operator decision.

## Deployment troubleshooting

- **Health fails:** inspect Host logs, data-directory ownership, bind address, port, and free disk.
- **Login/cookies fail:** require HTTPS, set `OPENGUI_BASE_URL` to the public origin, and preserve a
  stable `OPENGUI_AUTH_SECRET`.
- **Browser requests fail:** set an exact `OPENGUI_CORS_ORIGIN` and verify proxy streaming/timeouts.
- **Projects are missing:** check `OPENGUI_ALLOWED_ROOTS`, path grants, mounts, and host-control UID.
- **Models or MCP fail:** verify endpoint reachability, credentials, entitlement, TLS, and the
  connection health shown in Settings. Do not paste secrets into prompts or issue reports.
