# Changelog

## 0.6.0-rc.1 — release candidate

This candidate replaces the external coding-agent integration architecture with the first-party
OpenGUI Host and Harness. It is a minor release because it adds substantial product capabilities
and changes Session persistence; it is not yet the stable 0.6.0 release.

### Highlights

- First-party Harness with durable Host-owned Sessions, automatic context compaction, Agent
  Skills, image input/tool support, and the built-in `read`, `write`, `edit`, and `shell` tools.
- Multi-user Remote Hosts with Accounts, invites, roles, explicit path/model/Session grants,
  Host API keys, and private Sessions by default.
- Model backends and member-facing model offerings with Host/Team/User ownership planes.
- Host-owned MCP stdio and Streamable HTTP connections, bounded discovery, connection health,
  last-known-good catalogs, and recoverable tool failures.
- Refined sidebar Project/Session hierarchy and transcript, model, provider, and settings work.

### Breaking migration note

Sessions created by the old external-Harness architecture are **not imported** into the new
first-party Harness database. OpenGUI does not delete or modify the external Harness source files,
but those Sessions do not appear in the new sidebar. Treat the old application data as a separate
backup if it must be retained. There is no supported automatic importer in this candidate.

The exported MCP broker contract is also new for 0.6: consumers must call `refresh(scope)` before
expecting `catalog(scope)` to contain tools, and catalog diagnostics are scoped to the actor and
Session. This is an intentional prerelease API boundary rather than a 0.5-compatible adapter.

Remote Host operators should back up the Host data directory before upgrading and test the
candidate against a copy. Desktop, Web/Docker, and Android packaging still require platform smoke
testing; macOS artifacts are unsigned unless release signing is configured, and the Android
candidate currently uses the repository's temporary debug signing configuration.
