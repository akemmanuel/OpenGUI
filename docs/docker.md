# OpenGUI Docker

Official image:

```txt
ghcr.io/akemmanuel/opengui
```

Stable tags published on GitHub releases:

- `latest` -> newest stable release
- `vX.Y.Z` -> exact release tag
- `X.Y.Z` -> exact release version

Docker pulls image automatically on first run. No Docker Hub account needed.

OpenGUI web supports two Docker modes.

## Host-control mode

Host-control mode uses Docker for install and process management, but runs host CLIs (`git`, `opencode`, `claude`, `codex`, etc.) through `nsenter`.

**Security warning:** this mode uses `--privileged`, `--pid host`, host mounts, and often `--network host`. Treat it like SSH access to host. Do not expose Bun server port directly to internet.

### Run behind reverse proxy (recommended for servers)

Bind OpenGUI to loopback and put Apache or another HTTPS reverse proxy in front:

```bash
docker run --rm -it \
  --name opengui \
  --network host \
  --pid host \
  --privileged \
  -e HOST=127.0.0.1 \
  -e PORT=4839 \
  -e OPENGUI_OPENCODE_PORT=48391 \
  -e OPENGUI_HOST_EXEC=1 \
  -e OPENGUI_HOST_UID="$(id -u)" \
  -e OPENGUI_HOST_GID="$(id -g)" \
  -e OPENGUI_HOST_HOME="$HOME" \
  -e OPENGUI_ALLOWED_ROOTS="$HOME/Code" \
  -v "$HOME:$HOME" \
  ghcr.io/akemmanuel/opengui:latest
```

Proxy `https://your-hostname` to `http://127.0.0.1:4839` and forward WebSocket upgrades for `/api/events`.

See [apache.md](apache.md) for Apache Basic Auth example.

### Run for LAN access

If you want direct LAN or phone access without reverse proxy, override host bind:

```bash
docker run --rm -it \
  --name opengui \
  --network host \
  --pid host \
  --privileged \
  -e HOST=0.0.0.0 \
  -e PORT=3000 \
  -e OPENGUI_OPENCODE_PORT=48391 \
  -e OPENGUI_HOST_EXEC=1 \
  -e OPENGUI_HOST_UID="$(id -u)" \
  -e OPENGUI_HOST_GID="$(id -g)" \
  -e OPENGUI_HOST_HOME="$HOME" \
  -e OPENGUI_ALLOWED_ROOTS="$HOME/Code" \
  -v "$HOME:$HOME" \
  ghcr.io/akemmanuel/opengui:latest
```

Open:

```txt
http://127.0.0.1:3000
```

From phone on LAN:

```txt
http://SERVER-IP:3000
```

Only paths under `OPENGUI_ALLOWED_ROOTS` appear in server folder browser.

## Compose

`docker-compose.yml` defaults to safer reverse-proxy shape: localhost bind on `127.0.0.1:4839` plus dedicated OpenCode port `48391`.

```bash
OPENGUI_HOST_UID=$(id -u) \
OPENGUI_HOST_GID=$(id -g) \
OPENGUI_ALLOWED_ROOTS="$HOME/Code" \
docker compose up -d
```

Pin exact image version if you do not want `latest`:

```bash
OPENGUI_IMAGE=ghcr.io/akemmanuel/opengui:v0.5.3 \
OPENGUI_HOST_UID=$(id -u) \
OPENGUI_HOST_GID=$(id -g) \
OPENGUI_ALLOWED_ROOTS="$HOME/Code" \
docker compose up -d
```

Override `HOST=0.0.0.0` only if you intentionally want direct LAN exposure.

## Contained mode

Contained mode runs CLIs installed inside container. Mount projects under `/workspace`:

```bash
docker run --rm -it \
  -p 3000:3000 \
  -e HOST=0.0.0.0 \
  -e OPENGUI_ALLOWED_ROOTS=/workspace \
  -v "$HOME/Code:/workspace" \
  ghcr.io/akemmanuel/opengui:latest
```

## Build from source

If you want local image instead of GHCR:

```bash
docker build -t opengui:web .
```

Then replace `ghcr.io/akemmanuel/opengui:latest` with `opengui:web` in commands above.

## Notes

- Browser folder picker in web mode uses server paths, not client filesystem paths.
- Keep `OPENGUI_ALLOWED_ROOTS` narrow.
- If you publish this on internet, use HTTPS and auth at reverse proxy layer.
