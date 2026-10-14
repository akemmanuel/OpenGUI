# Effect as the server-side runtime

## Status

accepted

## Context

The Host, Harness, desktop main process and web server do a lot of work that is
easy to get subtly wrong with bare Promises: retries with budgets, wall-clock
deadlines, cancellation that must release sockets and child processes, locks and
files that must be released on every exit path, and an ordered shutdown. Each
place solved this by hand (`settled` flags, `setTimeout` deadlines,
`Promise.race`, `AbortController` plumbing, `finally` chains), and every version
had its own edge cases.

Effect 4 models exactly these concerns: typed errors, interruption with
finalizers, `Scope`-managed resources, `Schedule`-driven retries, and services
composed with `Layer`.

## Decision

Server-side code (`packages/backend`, `packages/harness`, `main/`, `server/`)
uses Effect 4 for control flow that involves retries, timeouts, cancellation,
resources or concurrency. The React frontend does not use Effect.

Conventions:

- **Errors** are `Schema.TaggedError` classes with a stable `_tag` and the
  fields callers need (`reason`, `committed`, `path`, ...). Expected failures go
  in the error channel; bugs are defects.
- **Functions** that return an Effect use `Effect.fn("Name")` when a tracing span
  helps and `Effect.fnUntraced` otherwise. Inline code uses `Effect.gen`.
- **Retries** use `Effect.retry` with a `Schedule` and a `while` predicate that
  states exactly which errors are safe to repeat.
- **Deadlines** use `Effect.timeoutOrElse`; the interrupted operation cleans up
  through its finalizer (for example `Effect.callback` returning a cleanup).
- **Resources** (locks, servers, child processes, connections) are acquired with
  `Effect.acquireRelease` inside a `Scope`; closing the scope releases them in
  reverse order.
- **Services** are `Context.Service` classes provided by `Layer`s, and the Host
  composition root owns a `ManagedRuntime`; disposing it is the shutdown path.
- **Promise boundaries** stay where callers are Promise-based (Hono handlers,
  Electron IPC, existing public APIs). They run effects with
  `Effect.runPromise(effect, { signal })`, so an `AbortSignal` interrupts the
  fiber. Effect 4 rejects with the original error object, so `instanceof`
  checks and error fields survive the boundary.

## Consequences

- Cancellation, deadlines and cleanup are declared once per operation instead of
  being re-implemented with flags and timers.
- Public APIs keep their Promise signatures while internals move to Effect, so
  migration is incremental and the existing test suite guards behaviour.
- Contributors need to know Effect basics; the installed package ships guidance
  in `node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/`.
