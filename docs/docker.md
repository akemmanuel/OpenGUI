# Docker

OpenGUI Docker images run the web backend with the Bun runtime. Dependencies are installed from `pnpm-lock.yaml`, and the frontend bundle is built with Vite+ (`vp build`).

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
- `OPENGUI_ALLOWED_ROOTS`: colon-separated roots the browser file picker may access

## Host-Control Mode

Host-control mode lets OpenGUI call host CLIs through `nsenter`. The compose file enables it with:

```yaml
network_mode: host
pid: host
privileged: true
OPENGUI_HOST_EXEC: "1"
```

The wrapper exposes common commands such as `git`, `opencode`, `claude`, `codex`, `pi`, `bun`, `node`, `python`, and `rg` through `/usr/local/host-bin`.

Set these variables to match the host user:

- `OPENGUI_HOST_UID`
- `OPENGUI_HOST_GID`
- `OPENGUI_HOST_HOME`
- `OPENGUI_HOST_PATH`

For internet-facing deployments, bind OpenGUI to localhost and put HTTPS/auth in front of it.
