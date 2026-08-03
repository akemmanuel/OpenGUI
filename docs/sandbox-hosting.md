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
