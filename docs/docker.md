# OpenGUI Docker

OpenGUI web supports two Docker modes.

## Host-control mode

Host-control mode uses Docker for install and process management, but runs host CLIs (`git`, `opencode`, `claude`, `codex`, etc.) through `nsenter`.

**Security warning:** this mode uses `--privileged`, `--pid host`, host mounts, and often `--network host`. Treat it like SSH access to host. Do not expose Bun server port directly to internet.

### Build

```bash
docker build -t opengui:web .
```

### Run behind reverse proxy (recommended for servers)

Bind OpenGUI to loopback and put Apache or another HTTPS reverse proxy in front:

```bash
docker run --rm -it \
  --name opengui-test \
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
  opengui:web
```

Proxy `https://your-hostname` to `http://127.0.0.1:4839` and forward WebSocket upgrades for `/api/events`.

See [apache.md](apache.md) for Apache Basic Auth example.

### Run for LAN access

If you want direct LAN or phone access without reverse proxy, override host bind:

```bash
docker run --rm -it \
  --name opengui-test \
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
  opengui:web
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
docker compose up --build
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
  opengui:web
```

## Notes

- Browser folder picker in web mode uses server paths, not client filesystem paths.
- Keep `OPENGUI_ALLOWED_ROOTS` narrow.
- If you publish this on internet, use HTTPS and auth at reverse proxy layer.
