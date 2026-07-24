# Docker

OpenGUI Docker images run the web backend with the Node.js runtime. Dependencies are installed with Bun for faster image builds, and the frontend bundle is built with Vite+ (`pnpm vp build` locally; the image build invokes the same task).

## Quick Start

```bash
docker compose up -d
```

The default compose file binds OpenGUI to `127.0.0.1:${PORT:-4839}` and enables host-control mode.

## Contained Mode

Contained mode runs tools inside the container. Use this when projects and agent CLIs are installed in the container image or mounted into it.

Important environment variables:

- `HOST`: bind address, defaults to `0.0.0.0` in the image
- `PORT`: web server port, defaults to `3000` in the image
- `OPENGUI_SERVER_MODE`: deployment mode. Use `combined` to serve API and frontend assets, or `api-only` to serve only `/api/*`.
- `OPENGUI_AUTH_TOKEN`: optional upgrade credential accepted only before first-owner setup. It is rejected after setup and is not a product login. Complete Account setup in the Web UI, then use an Account session or a named Host API key.
- `OPENGUI_AUTH_SECRET`: optional persistent Better Auth secret. If omitted, the Host generates and stores one in its identity SQLite database.
- `OPENGUI_BASE_URL`: public Host origin used by authentication, for example `https://opengui.example.com` behind an HTTPS reverse proxy.
- `OPENGUI_PATH_GRANTS`: Remote Hosts default to `enforced`, making project/file APIs share-only for members and member API keys. `disabled` is an explicit trusted-circle compatibility mode. These grants mediate OpenGUI product/file surfaces; they are not a shell jail, and the agent shell still runs with the Host OS user's authority.
- `OPENGUI_ALLOWED_ROOTS`: comma-separated roots the browser/server file picker may access. Use `/` only for fully trusted deployments.

## Multi-user access

The first browser visit creates the Host owner Account. The owner can then choose **Invite only** (the default) or **Open registration** in **Settings → Team**. Open registration creates Accounts without project access; an owner or permitted inviter must explicitly share paths.

Remote Sessions are private to their owner by default. Session owners and admins can share view, continue, or admin access with Accounts or the Team. Public view links expose only a read-only transcript and can be revoked. Model credentials are separated into Host, Team, and personal planes; shared Host/Team connections require explicit model entitlements, while personal connections remain solo-only.

Path shares constrain OpenGUI's project picker and file APIs. OpenGUI currently targets trusted circles, not hostile multi-tenancy: the unrestricted shell is **not** confined by path shares. Use separate containers or operating-system users when adversarial isolation is required.

## Host-Control Mode

Host-control mode lets OpenGUI call host CLIs through `nsenter`. The compose file enables it with:

```yaml
network_mode: host
pid: host
privileged: true
OPENGUI_HOST_EXEC: "1"
```

The wrapper exposes common commands such as `git`, `opencode`, `claude`, `codex`, `pi`, `node`, `npm`, `pnpm`, `python`, and `rg` through `/usr/local/host-bin`.

Set these variables to match the host user:

- `OPENGUI_HOST_UID`
- `OPENGUI_HOST_GID`
- `OPENGUI_HOST_HOME`
- `OPENGUI_HOST_PATH`

For internet-facing deployments, bind OpenGUI to localhost and put HTTPS/auth in front of it.

## API-only Backend

Set `OPENGUI_SERVER_MODE=api-only` to run only the OpenGUI Backend API. Non-API routes return 404, while `/api/health` remains public and reports `servesFrontend: false`.

```bash
OPENGUI_SERVER_MODE=api-only OPENGUI_ALLOWED_ROOTS=/ docker compose up -d
```

Use `/` for `OPENGUI_ALLOWED_ROOTS` only when the Backend host is fully trusted, because it allows OpenGUI to browse and operate anywhere the Backend process can access.
