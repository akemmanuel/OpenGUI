# OpenGUI first-party Harness release-readiness plan

## Current assessment

The first-party migration is substantially implemented, but it is not ready to tag as a stable
release yet. The repository currently passes the local quality gates (`check`, `test`,
`slop-check`, and `build`) and has removed the legacy Runtime and external coding-agent
dependencies. The remaining work is primarily correctness coverage, platform acceptance,
security/operations, documentation, and release automation.

The repository is prepared as **0.6.0-rc.1**, not 1.0.0. The first-party architecture, multi-user
Host, model offerings, MCP, compaction, image handling, and sidebar hierarchy justify a SemVer
minor release from 0.5.x. A 1.0.0 stability promise is not justified while platform signing and
acceptance, credential custody, backup/corruption procedures, and several P0/P1 checks below remain
open.

On 2026-07-31 the release-preparation pass also corrected the stale sidebar test, completed bounded
MCP health/refresh behavior, synchronized the current architecture and deployment docs, added the
0.5.x migration warning, and changed tag CI so the GitHub Release waits for Linux, Windows, macOS,
Android, and Docker jobs. On 2026-08-01, pull request #138 passed the complete Node.js 24 quality
gate and the non-publishing candidate workflow built Linux, Windows, macOS x64/arm64, Android, and
Docker amd64/arm64 artifacts, health-smoked both Docker images, merged updater metadata, and
generated checksums. Those candidate artifacts still require the manual platform and product smoke
tests below before tagging.

This plan supersedes the unchecked phase status in
[`first-party-harness-replacement.md`](./first-party-harness-replacement.md) for release tracking.
That document remains the architectural migration plan.

## Release definition

A release candidate is ready when a clean user can:

1. install OpenGUI Desktop on Windows, macOS, or Linux;
2. sign in with ChatGPT/Codex or configure a documented OpenAI-compatible endpoint;
3. connect a Project directory and create a Session;
4. complete and abort work involving all four tools;
5. restart or disconnect without losing durable transcript state; and
6. understand that Web and Mobile require an authenticated Remote Host.

The release must not require Git or an external coding-agent CLI.

## P0 — stabilize the migration branch

- [x] Split the release-preparation work into reviewable commits (decision/docs, Harness, Host,
      Frontend cutover, legacy deletion, OAuth/provider work, release docs).
- [x] Resolve staged/unstaged overlap and commit all intended files; do not release from a dirty
      tree.
- [ ] Update `first-party-harness-replacement.md` checkboxes to match implemented reality and
      explicitly list deferred items.
- [x] Replace the stale legacy architecture map in `docs/architecture.md` with the current
      Frontend → Host → Harness ownership and paths.
- [x] Archive or clearly mark superseded plans so contributors do not follow Runtime/bridge plans.
- [x] Align the pnpm version in `package.json`, `README.md`, `CONTRIBUTING.md`, and `AGENTS.md`.
- [x] Add pull-request CI for `check`, `test`, `slop-check`, and `build`; tag-only preflight is too
      late to discover regressions.

**Exit gate:** clean tree, coherent documentation, and required checks passing on every PR.

## P0 — close Harness correctness gaps

- [ ] Add schema-versioned SQLite migrations and tests upgrading from every released schema.
- [ ] Add deterministic context accounting and automatic compaction before overflow, including
      replay tests and failed-overflow behavior.
- [ ] Implement and test Agent Skills discovery for bundled, Host-global, and Project-local
      `SKILL.md` files with validation and progressive disclosure.
- [ ] Expand tool tests for missing/binary/large/Unicode/absolute paths, atomic-write failure,
      edit mismatch, malformed arguments, and output line/byte bounds.
- [ ] Add abort coverage during model streaming and each tool, not only POSIX shell execution.
- [ ] Add Windows PowerShell quoting, exit-code, timeout, and descendant-process termination tests.
- [ ] Verify full shell output retention has bounded lifecycle/cleanup and cannot leak credentials
      through diagnostics.
- [ ] Test concurrent send/follow-up/abort requests and enforce one active Run per Session at the
      Host boundary.

**Exit gate:** the Harness test matrix in the migration plan is implemented on Linux, macOS, and
Windows CI.

## P0 — model and credential reliability

- [ ] Create one adapter-conformance suite and run it against recorded/fake Chat Completions and
      Codex Responses streams: text, reasoning, partial tool JSON, multiple calls, Unicode, empty
      output, usage, malformed streams, rate limits, abort, and overflow.
- [ ] Test Codex device login, expiry, refresh, revocation, cancellation, and restart persistence.
- [ ] Confirm that Codex OAuth distribution is permitted and document the supported behavior.
- [ ] Store Desktop model credentials in OS-backed secure storage and define encrypted/secret-store
      handling for Remote Hosts; prove secrets never enter Session SQLite, logs, or frontend
      persistence.
- [x] Document the exact supported OpenAI-compatible contract and reject unsupported endpoint
      behavior with actionable errors.
- [ ] Add provider diagnostics visible to users: endpoint reachability, authentication state,
      selected model, and retry guidance.

**Exit gate:** clean-install authentication and a four-tool Session survive credential refresh and
application restart.

## P0 — Host, reconnection, and security

- [ ] Add end-to-end tests for Session create/read/rename/delete, send, FIFO follow-up, abort, and
      ordered event streaming through the real Host transport.
- [ ] Test two clients observing and controlling one Session, including disconnect/reconnect during
      a Run and recovery from durable entries plus the live snapshot.
- [ ] Prove Runs continue after all Frontends disconnect.
- [ ] Test authentication on every non-health Remote Host route and fail closed when remote binding
      has no token.
- [ ] Define CORS/origin behavior, TLS reverse-proxy guidance, upload limits, allowed-root behavior,
      and path traversal tests.
- [x] Add SQLite backup, restore, corruption handling, WAL checkpoint, and upgrade documentation.
- [x] Decide what happens to legacy queued prompts and old Session databases; never silently
      dispatch or claim import.

**Exit gate:** multi-client and restart acceptance pass against both Desktop private transport and
authenticated HTTP/events.

## P1 — product acceptance and UX polish

- [ ] Re-capture all states from `first-party-harness-ui-baseline.md` and compare Desktop and Mobile
      hierarchy, transcript rendering, tool calls, scrolling, settings, and PromptBox behavior.
- [ ] Dogfood a long real Session using `read`, `write`, `edit`, and `shell`; include failure,
      timeout, abort, follow-up, restart, and reconnect paths.
- [ ] Replace remaining unavailable actions with either implemented behavior or intentionally
      removed UI (for example summarize/slash-command paths); do not ship controls that only throw.
- [ ] Verify setup, provider errors, empty states, offline/reconnecting state, interrupted Runs,
      and destructive confirmations.
- [ ] Run keyboard-only, screen-reader-label, focus, reduced-motion, and WCAG AA contrast checks.
- [ ] Verify all changed user-facing strings in every supported locale: English, German, and
      Spanish.
- [ ] Address the 4.25 MB frontend chunk warning with code splitting, or record and enforce an
      accepted bundle-size budget.

**Exit gate:** a lightly technical tester can complete the release definition without developer
assistance.

## P1 — platform and packaging acceptance

- [ ] Windows: clean VM install/uninstall, no Git/Bash prerequisite, PowerShell paths with spaces
      and Unicode, process-tree abort, NSIS artifact, and update metadata.
- [ ] macOS x64/arm64: app-launched PATH, configured shell, signing, notarization, Gatekeeper,
      DMG/ZIP artifacts, and update metadata. Do not call an unsigned build production-ready.
- [ ] Linux: AppImage and deb clean installs, `/bin/sh` fallback, desktop integration, abort, and
      update behavior.
- [ ] Web/Docker: authenticated Remote Host, persistent volume, non-root execution where possible,
      health check, upgrade/rollback, backup, and reverse-proxy TLS instructions.
- [ ] Android: signed release artifact, remote-Host setup, reconnect/send/follow-up/abort/uploads,
      back navigation, notifications, and explicit no-local-execution language.
- [ ] Decide whether iOS is in this release. If yes, add a project, signing pipeline, and device
      acceptance; if no, remove broad iOS availability claims.

**Exit gate:** signed artifacts are manually smoke-tested on clean supported systems and their
checksums are retained.

## P1 — release documentation and automation

- [x] Rewrite `docs/docker.md` to remove external CLI/agent wording and document first-party Host
      execution and its unrestricted security implications.
- [x] Rewrite `docs/mobile.md` to use Host terminology and provide an actual connection procedure.
- [x] Add security, privacy/telemetry, credential storage, backup/restore, troubleshooting, and
      supported-platform documentation.
- [x] Add a changelog/migration note stating that old external-Harness Sessions are not imported.
- [x] Correct stale Docker image labels and add amd64/arm64 image smoke/health tests before publishing.
- [x] Add a manually dispatched release-candidate workflow that packages without immediately publishing. Tag/package
      version consistency validation is now part of the tag preflight.
- [x] Make GitHub Release publication wait for every required artifact; Linux, Windows, macOS,
      Android, and Docker jobs now gate Release creation.
- [x] Generate SHA-256 checksums for candidate artifacts. Signing, attestations, and provenance
      remain secret-/policy-dependent release work.

## Release-candidate sequence

1. Freeze features; accept only release blockers.
2. Complete every P0 item and cut `v0.6.0-rc.1` (the architecture replacement warrants a minor
   version rather than a patch).
3. Package unsigned/internal candidates and run the full platform matrix.
4. Run the product acceptance script on Desktop, Web/Docker, and Android; record evidence and
   issues in a release checklist.
5. Fix blockers, repeat all automated gates, and cut additional RCs as needed.
6. Sign/notarize production artifacts, verify checksums and update manifests, then publish the
   stable tag and migration notes.
7. Monitor authentication failures, model stream errors, SQLite failures, crashes, and update
   failures; keep a documented rollback path to the previous stable release.

## Automated gate for every candidate

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run test
pnpm run slop-check
pnpm run build
```

Also require platform packaging jobs and end-to-end acceptance. Passing the five local commands is
necessary but not sufficient for release.
