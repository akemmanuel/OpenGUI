# Manual acceptance: harness-only session reads (ADR 0006)

Run on **Desktop** (`pnpm run dev`) or **Web** (`pnpm run dev:web`) before a release that touches session list, messages, or harness connectivity.

## Setup

1. Ensure at least one **Model-ready Harness** (e.g. Pi) and a **Project** directory on disk.
2. Connect the Project in the active **Workspace**.

## Checklist

| Step | Action                                                                               | Expected                                                                                      |
| ---- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 1    | Add / connect Project                                                                | Project appears in sidebar; no ghost “Recovered session” rows                                 |
| 2    | List sessions                                                                        | Only sessions the Harness returned for that `(directory, harnessId)`                          |
| 3    | Open a session                                                                       | Transcript loads; errors show as errors (not an empty thread)                                 |
| 4    | Stop Harness or make CLI unavailable (quit daemon / rename binary temporarily)       | List or refresh shows **error** or empty with visible harness failure — not invented sessions |
| 5    | Open chat with wrong/unknown session id (stale bookmark or manual URL if applicable) | **Error** from message fetch — not `{ messages: [] }` with no message                         |

## Automated companions

```bash
pnpm run session-read-acceptance
```

Runs `src/adr-0006-session-read-acceptance.test.ts` plus related server/protocol/hook tests and `slop-check`.

| Manual step | Automated coverage                                                                          |
| ----------- | ------------------------------------------------------------------------------------------- |
| 1–2         | No ghost sessions; harness-only list merge                                                  |
| 3–5         | `getMessages` errors propagate; transcript `page.failed` / `SESSION_ERROR`                  |
| 4 (partial) | Query `errors[]` + hydration `failedBackends` — **still** stop Harness manually for full UX |

Steps 4–5 in the table above still need a manual run on Desktop or Web before release.

See also: [session-read-slop-removal.md](../plans/session-read-slop-removal.md), [ADR 0006](../adr/0006-harness-only-session-and-transcript-reads.md).
