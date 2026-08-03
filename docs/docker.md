# Docker Remote Host

The OpenGUI image runs a first-party **Remote Host** and the Web shell. The Host owns the Harness,
Sessions, model and MCP connections, Accounts, and authorization. It does not require or import an
external coding-agent CLI. The image uses Node.js 24, pnpm 11.8.0, the repository's frozen lockfile,
and Vite+ for the application bundles.

## Quick start (trusted host-control mode)

```bash
docker compose up -d
curl --fail http://127.0.0.1:${PORT:-4839}/api/health
```

For this prerelease, select the RC explicitly because prereleases never update `latest`:

```bash
OPENGUI_IMAGE=ghcr.io/akemmanuel/opengui:0.6.0-rc.2 docker compose up -d
```

Open `http://127.0.0.1:4839`. The first browser creates the Host owner Account. The compose file
persists Host state in the `opengui-data` volume at `/app/.opengui-data`.

The supplied compose file enables **host-control mode**: privileged PID/host networking plus
`nsenter` wrappers let the Harness execute commands as the configured host user. This is powerful,
not containment. Use it only on a trusted machine, bind it to loopback, and terminate public HTTPS
at a reverse proxy.

## Contained mode

For a narrower deployment, remove `network_mode: host`, `pid: host`, `privileged: true`, the host
home bind mount, and `OPENGUI_HOST_EXEC`. Mount only intended Project directories under
`/workspace`, publish the container port, and set `OPENGUI_ALLOWED_ROOTS` to those mounts. Tools
then run inside the container with the container process's permissions. Container isolation is the
security boundary; OpenGUI Project paths alone are not a shell sandbox.

For mutually untrusted customers who need shell and Git deployment, use a separate rootless
gVisor Remote Host for each customer. The supported Compose contract and complete setup are in
[`sandbox-hosting.md`](./sandbox-hosting.md). Do not register unrelated customers on one
host-control-mode Host.

## Configuration

| Variable                                                          | Purpose                                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `HOST`, `PORT`                                                    | Bind address and port. The image defaults to `0.0.0.0:3000`; compose defaults to loopback port `4839`. |
| `OPENGUI_SERVER_MODE`                                             | `combined` serves API + Web shell; `api-only` serves only `/api/*`.                                    |
| `OPENGUI_DATA_DIR`                                                | Durable Host state directory. Compose sets `/app/.opengui-data`.                                       |
| `OPENGUI_BASE_URL`                                                | Public HTTPS origin used by Host authentication. Set this behind a reverse proxy.                      |
| `OPENGUI_AUTH_SECRET`                                             | Stable Better Auth secret. If omitted, the Host generates and persists one in identity SQLite.         |
| `OPENGUI_AUTH_TOKEN`                                              | Optional one-time upgrade/bootstrap credential before owner setup; not a normal Account login.         |
| `OPENGUI_CORS_ORIGIN`                                             | Allowed browser origin. Set the exact public origin for split frontend/API deployments.                |
| `OPENGUI_ALLOWED_ROOTS`                                           | Comma-separated outer roots exposed to Host project/file APIs. Avoid `/` unless fully trusted.         |
| `OPENGUI_PATH_GRANTS`                                             | Remote default is `enforced`; `disabled` is trusted-circle compatibility mode.                         |
| `OPENGUI_UPLOAD_MAX_FILE_BYTES`, `OPENGUI_UPLOAD_MAX_BATCH_BYTES` | Upload limits.                                                                                         |
| `OPENGUI_REQUEST_MAX_BYTES`                                       | General JSON/request body limit.                                                                       |

In host-control mode also set `OPENGUI_HOST_UID`, `OPENGUI_HOST_GID`, `OPENGUI_HOST_HOME`, and
`OPENGUI_HOST_PATH` to the host account used for execution. The wrapper exposes only its configured
command links; model and MCP setup happens through OpenGUI settings.

## Multi-user access and security

After owner setup, choose **Invite only** (default) or **Open registration** under
**Settings → Team**. Membership grants no Project, model offering, or Session access by itself.
Remote Sessions are private by default; owners/admins grant paths and model offerings explicitly,
and Session owners share `view`, `run`, or `admin` access.

Path grants constrain OpenGUI product/file surfaces. Restricted actors cannot use unrestricted
shell while enforcement is active, but this is not hostile multi-tenant isolation. Run separate
containers or operating-system accounts for mutually untrusted users. Keep the Host on HTTPS,
restrict CORS, and do not expose host-control mode directly to the internet.

## Backup and upgrade

Stop the container before a cold backup, then archive the `opengui-data` volume (or the directory
mapped to `OPENGUI_DATA_DIR`). Back up mounted Projects separately; they are not stored in the Host
data volume. Restore by attaching the saved data directory to the same `OPENGUI_DATA_DIR` before
starting the replacement image.

Before changing image tags:

1. back up Host data and Projects;
2. pull the candidate without deleting the old image;
3. start it against a copy of Host data and check `/api/health`, login, a Session, and tool use;
4. stop and restore the prior image + backup if the smoke test fails.

The 0.6 migration does not import old external-Harness Sessions; see [`CHANGELOG.md`](../CHANGELOG.md).

## API-only mode

```bash
OPENGUI_SERVER_MODE=api-only docker compose up -d
```

Non-API routes return 404 while `/api/health` remains public. Connect a Desktop or Mobile
Workspace to the API origin and authenticate with a Host Account or named Host API key.
