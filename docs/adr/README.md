# Architecture decision records

Read these when code or docs disagree about **who owns what**.

| ADR                                                         | Topic                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [0001](./0001-harness-terminology.md)                       | **Harness** vs old “agent backend” naming                                               |
| [0002](./0002-uploaded-prompt-files.md)                     | Uploaded prompt files (`@path` mentions), not image attachments                         |
| [0003](./0003-persistent-desktop-backend-transport.md)      | Desktop Local Workspace: private IPC, persistent backend process                        |
| [0004](./0004-storage-source-of-truth-boundaries.md)        | Harness vs Backend SQLite vs Frontend persistence                                       |
| [0005](./0005-opengui-runtime-backend-split-and-sdk.md)     | **Runtime / Backend / Frontend** split; `@opengui/runtime` SDK                          |
| [0006](./0006-harness-only-session-and-transcript-reads.md) | Session list and message pages: Harness-only, strict scope                              |
| [0007](./0007-runtime-sdk-minimal-surface.md)               | **`@opengui/runtime` minimal SDK** — SessionHandle, stream/wait; not Pi platform        |
| [0008](./0008-session-transcript-projection-in-runtime.md)  | **Session transcript projection** in Runtime; Frontend render-only                      |
| [0009](./0009-frontend-composition-and-loc-reduction.md)    | **Frontend composition** + ~30% net LoC reduction strategy (features over god provider) |

Product glossary (no implementation detail): [`CONTEXT.md`](../../CONTEXT.md).

Contributor codebase map: [`docs/architecture.md`](../architecture.md).

Ongoing improvement plan: [`docs/plans/contributor-experience-and-slop-removal.md`](../plans/contributor-experience-and-slop-removal.md).
