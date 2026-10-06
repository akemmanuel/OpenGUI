# Sandboxed customer Hosts with gVisor

The sandbox deployment runs one OpenGUI Remote Host per customer under rootless Docker and gVisor.
It is intended for customers who need the complete `read`, `write`, `edit`, and `shell` tool set
without receiving an operating-system login on the machine that operates OpenGUI.

An OpenGUI Account is identity inside one customer trust domain. The gVisor container is the
isolation seam between customers. Do not put unrelated customers into one sandbox Host, and never
mount the rootful Docker socket, an operator home, or another customer's workspace.

## Result

Each deployment provides:

- Host-embedded Account setup and login;
- a customer-only `/workspace` with unrestricted Harness shell inside the sandbox;
- a persistent OpenGUI data volume and sandbox home;
- a write-enabled, repository-scoped GitHub deploy key;
- loopback-only HTTP for an HTTPS reverse proxy;
- gVisor `runsc` with the `systrap` platform, which does not require `/dev/kvm`;
- dropped capabilities, no-new-privileges, a read-only root filesystem, and resource limits.

The customer does not receive SSH access to the Docker host. GitHub receives source pushes from
inside the sandbox, and an existing Vercel Git integration can deploy those pushes normally.

## 1. Create a locked runtime account

Use a separate operating-system account and subordinate UID/GID range for every customer. Keep its
login password locked and deny `opengui-*` accounts in `sshd` as defense in depth. The account needs
a working user systemd session for rootless Docker; it does not need an SSH key or membership in the
rootful `docker` group.

Install rootless Docker according to the
[Docker rootless-mode documentation](https://docs.docker.com/engine/security/rootless/), enable
lingering for the runtime account, and confirm that its Docker context reports `name=rootless`.

## 2. Register gVisor with the rootless daemon

Install `runsc` from the official
[gVisor installation instructions](https://gvisor.dev/docs/user_guide/install/). Copy
[`../docker/sandbox/daemon.json`](../docker/sandbox/daemon.json) to the runtime account's
`~/.config/docker/daemon.json`, then restart that account's Docker user service.

The supplied configuration uses `systrap`. gVisor recommends it when running inside a virtual
machine or where KVM is unavailable. Verify the runtime:

```bash
docker info --format '{{json .SecurityOptions}}'
docker info --format '{{json .Runtimes}}'
docker run --rm --runtime=runsc hello-world
```

## 3. Prepare the workspace and GitHub deploy key

Create customer-owned directories outside any operator home:

```text
/home/opengui-customer/
  deployment/
  secrets/
  workspace/
```

Clone or copy exactly the customer's repository into `workspace`. Create an Ed25519 key without a
passphrase because Git must use it non-interactively:

```bash
ssh-keygen -t ed25519 -C opengui-customer-deploy \
  -f /home/opengui-customer/secrets/github-deploy-key -N ''
chmod 600 /home/opengui-customer/secrets/github-deploy-key
```

Add the `.pub` file under **GitHub repository → Settings → Deploy keys**, with **Allow write
access** enabled. A deploy key must be scoped to only that repository. Never reuse an operator key
or a key that can push to multiple customers' repositories.

Create `secrets/github-known-hosts` from GitHub's published SSH host keys and verify its fingerprint
against [GitHub's SSH key fingerprints](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints).
The Compose deployment enforces strict host-key checking; it must not silently trust a first
connection.

The repository remote must use SSH:

```bash
git -C /home/opengui-customer/workspace remote set-url origin git@github.com:OWNER/REPOSITORY.git
```

## 4. Configure and start OpenGUI

Copy [`../docker/sandbox/compose.yml`](../docker/sandbox/compose.yml) and
[`../docker/sandbox/.env.example`](../docker/sandbox/.env.example) into the customer's deployment
directory. Rename the example to `.env`, fill every path/origin, generate a stable random
`OPENGUI_AUTH_SECRET`, and set mode `0600` on `.env`.

Run the doctor as the runtime account with the deployment environment loaded:

```bash
set -a
. ./deployment/.env
set +a
node --experimental-strip-types /path/to/OpenGUI/scripts/sandbox-doctor.ts
```

Start the Host using the same rootless Docker context:

```bash
docker compose --env-file ./deployment/.env \
  -f ./deployment/compose.yml up -d
docker compose --env-file ./deployment/.env \
  -f ./deployment/compose.yml ps
```

Terminate public HTTPS at Caddy, nginx, or another reverse proxy and forward only to
`127.0.0.1:$OPENGUI_SANDBOX_PORT`. `OPENGUI_BASE_URL` must be the exact public HTTPS origin.

## 5. Account setup and deployment

Open the public URL. The first person completes Host setup and becomes owner. The supplied
single-customer Compose deployment uses `OPENGUI_PATH_GRANTS=disabled`, so Accounts in that
customer trust domain share the sandbox.

For Accounts that must have different path grants on one Host, set `OPENGUI_PATH_GRANTS=enforced`
and run [`../scripts/sandbox-shell-broker.ts`](../scripts/sandbox-shell-broker.ts) outside the Host
container. Configure the Host with an authenticated `OPENGUI_SHELL_SANDBOX_ENDPOINT` and
`OPENGUI_SHELL_SANDBOX_TOKEN`. Configure the broker with:

- `OPENGUI_SHELL_IMAGE`: immutable image used for each shell call;
- `OPENGUI_SHELL_ALLOWED_ROOTS`: outer roots the broker may ever mount;
- `OPENGUI_SHELL_BROKER_HOST`, `OPENGUI_SHELL_BROKER_PORT`, and
  `OPENGUI_SHELL_BROKER_TOKEN`;
- `OPENGUI_SHELL_RESOLV_CONF`: trusted resolver configuration mounted read-only;
- optional `OPENGUI_SHELL_DEPLOY_CREDENTIALS`: repository-root to deploy-key mappings.

Run `sandbox-doctor.ts` with the broker's `OPENGUI_SHELL_IMAGE` configuration and the same
rootless Docker context used by the broker before deployment, restart, upgrade, or rollback.
The doctor inspects the configured image locally and fails if it is missing or Docker cannot
inspect it; it never pulls or restores an image. Without `OPENGUI_SHELL_IMAGE`, the image check
is skipped for deployments that do not use the separate broker. A broker on another machine
must be checked on that machine, not against the web Host's Docker daemon.

A successful preflight or web `/api/health` response does not establish shell readiness. Verify
an actual authenticated restricted-Account shell call in a disposable granted Project, including
a read-only grant and denied access outside the grant. Repeat after cleanup and upgrades. This
doctor does not install image retention, recurring probes, alerts, or recovery automation.
Immutable image IDs/digests do not prevent image deletion; restore and verify the required image
before retrying deployment or rolling back. Do not use broad image/container/system pruning as
a readiness test.

## Shell image lifecycle automation

`scripts/sandbox-shell-lifecycle.ts` provides the regular repository automation for the
deployment lifecycle. It never mutates a Docker daemon in dry-run mode, never
emits global prune verbs, and never restarts services. Every command runs with:

```bash
node --experimental-strip-types scripts/sandbox-shell-lifecycle.ts <command> [--apply] [--lock <path>]
```

| Command          | Purpose                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `check`          | Verify configured image, `runsc` runtime, keeper container, and config consistency.        |
| `probe`          | Authenticated restricted-grant execution probe (write, read-only, out-of-grant, identity). |
| `retain`         | Preview (or with `--apply`, create) the unstarted keeper; `--keeper` for new-name moves.   |
| `cleanup`        | Plan (or with `--apply`, execute) label-scoped removal of disposable images only.          |
| `upgrade-plan`   | Print the ordered operator-driven upgrade sequence with current blockers.                  |
| `restore-verify` | Verify an offline archive checksum plus the loaded image digest as separate facts.         |
| `notify-test`    | Test the configured alert webhook, or confirm it stays OFF when unconfigured.              |

Run the existing `sandbox-doctor` isolation preflight first: rootless Docker remains
required. Lifecycle inspection and direct broker probes do not replace that preflight
or a controlled restricted Account-to-Harness acceptance check.

Configuration uses the existing broker variables plus a small lifecycle set:

- `OPENGUI_SHELL_IMAGE`: shell image reference. Until a separately versioned shell image is
  validated, pin this to the same tested release reference as the App image (`OPENGUI_IMAGE`);
  do not invent an untested minimal toolchain for production.
- `OPENGUI_SHELL_KNOWN_GOOD_IMAGE` / `OPENGUI_SHELL_PREVIOUS_KNOWN_GOOD_IMAGE`: last verified
  images. Cleanup always preserves them; rollback never targets an absent image.
- `OPENGUI_SHELL_KEEPER_CONTAINER` (default `opengui-shell-image-keepalive`): the single
  operator-owned keeper name this tooling manages.
- `OPENGUI_SHELL_PROBE_FIXTURE_ROOT`: disposable directory for `probe`. Create it with
  `probe --init-fixture`, which exclusively creates a fresh root (private `project`,
  `readonly`, `outside` dirs plus an identity marker) or verifies a pre-existing root is
  provably our fixture (exact marker content, no foreign entries, no symlinks) before
  touching anything. A foreign or symlinked directory is refused with zero changes, and
  existing paths are never chmodded — never point this at a customer project. The probe
  fails as `probe_not_configured` when the endpoint or an initialized fixture is absent;
  image inspection alone is never reported as shell readiness. Probes are direct broker
  checks only and do not verify the Host/Account-to-Harness path.
- `OPENGUI_SHELL_BROKER_IMAGE` (optional): the broker's configured image reference, used only
  to consistency-check keeper/broker/shell configuration. Unset means broker consistency is
  reported as unchecked, not as passing.
- `OPENGUI_SHELL_LIFECYCLE_WEBHOOK_URL`: generic HTTPS webhook for failure alerts. Unset means
  alerts stay OFF. `check`/`probe` send only with `--alert-on-failure`. Loopback `http://` is
  accepted for local fake-server tests only.
- `OPENGUI_SHELL_LIFECYCLE_LOCK` (default `$XDG_RUNTIME_DIR/opengui-shell-lifecycle.lock`):
  lock file serializing `retain --apply` and `cleanup --apply`. `--apply` opens the lock file
  itself (`O_NOFOLLOW`, created `0600` when absent), acquires a nonblocking kernel lock on
  that open file description via `flock -n`, holds its own fd for the entire mutation, then
  closes it. There is no relay process, no environment flag, and no internal entry point
  (the removed `__apply` route always refuses). The path must live in a private
  owner-controlled directory (no symlinks, parent owned by the operator and not
  group/world-writable). Contention fails fast before any Docker call; there are no
  unbounded waits.
- Restore expectations: `OPENGUI_SHELL_RESTORE_ARCHIVE`,
  `OPENGUI_SHELL_RESTORE_ARCHIVE_SHA256`, `OPENGUI_SHELL_RESTORE_IMAGE`, and
  `OPENGUI_SHELL_RESTORE_IMAGE_DIGEST`. The archive hash is streamed, never fully buffered.

### Keeper lifecycle and pruning scope

The keeper is an unstarted `docker create` container labeled `opengui.shell.keeper=true` that
pins one image ID. `retain --apply` uses the inspected immutable ID with `--pull=never`:
changing a tag cannot change the pinned image, and retention never initiates restoration.
It only helps against label-scoped image cleanup; it does **not** protect
against `docker rm -f`, `image rm --force`, `container prune`, or `system prune`, and it must
never be started for shell execution (a running keeper fails `check`). A foreign container that
collides with the keeper name is reported as `keeper_collision` and is never deleted or reused.

A keeper that collides with a foreign container, mismatches the configured image, or is
running is refused outright: `retain` never updates a keeper in place, never adopts an
unlabeled pre-existing container, and never deletes anything. Migrate explicitly with
`retain --keeper <new-name>`, verify with `check`, then remove the old container yourself
with `docker rm` only after the new keeper probes green.

Supported cleanup lists with `docker images --no-trunc`, inspects every candidate's real
`Config.Labels` and immutable ID, and resolves the configured, known-good, and keeper
references to immutable IDs first. Any protected reference that cannot be resolved fails the
run closed with zero removals. Unverifiable candidates, including truncated IDs, are excluded
and reported; they are never removed.
Only `opengui.shell.disposable=true` images survive to explicit `docker image rm -- <id>`,
re-verified immediately before each removal; every foreign image is excluded.
`image prune -a`, `container prune`, and `system prune` remain unsupported on shell hosts.
Re-run `check` and `probe` after any cleanup or upgrade.

### Upgrade, rollback, and recovery

1. Verify the new image (`check` with the new `OPENGUI_SHELL_IMAGE`).
2. Create a new-name keeper (`retain --keeper <new-name> --apply`); keepers are never
   updated in place.
3. Update the broker configuration to the new image consistently.
4. Restart the broker via explicit operator action; automation never restarts services and
   upgrade application is intentionally not automated.
5. Run `probe` against the restarted broker.
6. Mark the image known-good only after the isolation preflight, broker probe, and controlled
   restricted Account-to-Harness acceptance pass; keep the previous known-good as
   the rollback target, then `docker rm` the old keeper yourself. Rollback to an absent
   image is refused.

Pin deployments by immutable digest (`image@sha256:…`) and record the source revision label
(`org.opencontainers.image.revision`) at build time; `check` reports provenance guidance when
either is missing. Restore offline archives only through `restore-verify`: the archive file
is stream-hashed and compared to its expected checksum, then the already-loaded image is
inspected for the expected digest. Both are reported as separate facts; the explicit operator
`docker load` between them is not attested, and this tool never loads images itself.
Recurring `check`/`probe --alert-on-failure` runs notify through the configured webhook with
a fixed fault summary (no tokens, commands, or customer content); the systemd journal or a
unit state alone is not notification. A versioned scheduling example (operator-run
documentation, not installed automation):

```ini
# /etc/systemd/system/opengui-shell-lifecycle-check.service
[Unit]
Description=OpenGUI shell image lifecycle check
[Service]
Type=oneshot
EnvironmentFile=/path/to/deployment/opengui-shell-lifecycle.env
ExecStart=/usr/bin/node --experimental-strip-types /path/to/OpenGUI/scripts/sandbox-shell-lifecycle.ts check --alert-on-failure
```

```ini
# /etc/systemd/system/opengui-shell-lifecycle-check.timer
[Unit]
Description=Hourly OpenGUI shell lifecycle check
[Timer]
OnBootSec=10min
OnUnitActiveSec=1h
[Install]
WantedBy=timers.target
```

Diagnostics across all commands use fixed public-safe summaries; raw Docker stderr,
operator-configured references, endpoints, tokens, paths, and customer content never appear
in normal output. Only daemon-provided full image IDs appear in removal plans.

The Host re-resolves the actor's policy immediately before every tool effect. Restricted shell is
enabled only when the actor has grants and the broker is configured. Every invocation gets a new
gVisor container with only those canonical grant roots mounted; `read` grants are mounted read-only
and `write` grants read-write. The broker rejects projects outside the effective grants and mounts
neither Host data nor the Docker socket.

The customer can ask OpenGUI to edit, test, commit, and push, for example:

> Build the site, fix any errors, commit these changes, and push the current branch to origin.

The deploy key lets Git push only to the configured repository. Vercel remains responsible for its
Git-triggered production deployment. OpenGUI does not need a Vercel token.

## Security and operations

- A deploy key is readable from customer shell by design. Its safety comes from repository scope.
- Provider credentials and OpenGUI Host data stay outside `/workspace`, but remain inside the
  customer's sandbox. Never share one sandbox across unrelated customers.
- Outbound networking is enabled for model endpoints, package registries, and GitHub. Do not claim
  that this prevents source exfiltration.
- Back up the OpenGUI data volume, sandbox home, and workspace separately. Test restore before an
  OpenGUI upgrade.
- Pin a release image; do not use `latest` for production.
- Monitor disk, process, memory, and build-output growth. Resource limits protect availability but
  do not replace host monitoring.
- gVisor is defense in depth, not a virtual machine. Operators with a stronger hostile-tenant
  threat model should use separate machines or VMs.
