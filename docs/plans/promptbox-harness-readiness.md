# Plan: Harness → Provider → Model selection (PromptBox)

**Domain hierarchy (product language):**

```text
Harness
 └── Provider (0..n per harness, per project scope)
      └── Model (1..n per provider)
```

A **Provider** is a model/API vendor **inside** a Harness (OpenCode, Pi, etc.) — not the OpenGUI server. **Provider credentials** stay backend-owned ([CONTEXT.md](../../CONTEXT.md)).

**PromptBox selection** (execution intent for the next Agent send) must include:

1. **Harness** (which runtime)
2. **Model** (which model, within a provider)

Equivalently: `harnessId` + `providerID` + `modelID` (+ agent / variant as today). There is no separate “harness preference” control in the PromptBox chrome.

---

## Non-negotiable UX rules

| Rule                                   | Meaning                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No gray PromptBox for catalog gaps** | If Harness A returns no providers/models for this project, the textarea and PromptBox chrome stay **enabled**. Harness B must remain choosable inside the **selection dialog**. |
| **No send without selection**          | Agent send requires explicit Harness + Model (No PromptBox selection otherwise). No server default, no implicit model ([CONTEXT](../../CONTEXT.md)).                            |
| **No extra harness UI on PromptBox**   | No harness pills, tabs, or second control beside the textarea. Harness is chosen **inside** the same flow as model (harness step → provider sections → model).                  |
| **Project-connected Prompt only**      | PromptBox hidden when no project/session target — unchanged.                                                                                                                    |

**PromptBox action controls** ([CONTEXT](../../CONTEXT.md)): Send visibility follows text + session busy rules; **dispatch** is gated on complete selection, not on disabling the textarea.

---

## Target UX: one “selection” affordance

**PromptBox chrome (minimal):**

- One primary control (replaces today’s model-only label): shows **Harness + model** when selected, e.g. `Pi · Claude Sonnet …`, or **“Choose harness & model”** when not.
- **AgentSelector** / **VariantSelector** unchanged (depend on model).
- No additional harness row in the PromptBox strip.

**Selection dialog (single entry point):**

```text
┌─ Choose harness & model ─────────────────────────────┐
│ 1) Harness list (all managed harnesses)             │
│    - readiness hint per row (CLI, auth, catalog)    │
│    - locked harness when active session dictates    │
│ 2) After harness picked → loadResources for scope   │
│ 3) Provider sections — only providers with ≥1 model │
│    - no empty provider headers in the list          │
│    - harness has none: harness-level empty state    │
│      (pick another harness / Settings if auth)      │
│ Search: filters models across providers (optional)  │
└──────────────────────────────────────────────────────┘
```

**On pick model:** atomically commit `harnessId` + `SelectedModel` into PromptBox selection; close dialog; trigger routing for subsequent `loadResources` / events for that harness.

**Remove:** Harness chip row at top of current `ModelSelector` dialog (`setActiveTargetBackend` without choosing a model). Harness change happens only as **step 1** of this dialog (or explicit “Change harness” back navigation inside dialog).

---

## PromptBox selection state (frontend)

| Field                    | Source                                                                           |
| ------------------------ | -------------------------------------------------------------------------------- |
| `harnessId`              | User step 1 in dialog; or session **user message selection** when session locked |
| `providerID` + `modelID` | User step 3; stored as `selectedModel` today                                     |
| `agent`, `variant`       | Existing meta / selectors                                                        |

**Routing alignment:** `resolveActiveResourceHarnessRoute` should treat **PromptBox selection’s `harnessId`** as authoritative for pending/new chat, not a parallel `STORAGE_KEYS.HARNESS` “preferred backend” that UI never shows. Migration: last explicit selection writes harness; session lock overrides for open session.

**Session lock:** Opening a session with user message selection sets harness + model from transcript; dialog step 1 disabled with explanation (`modelSelector.harnessLocked`).

---

## Harness readiness (does not disable PromptBox)

Readiness is **per Harness** (and per project for catalogs), shown in:

- Selection dialog harness list (step 1)
- Settings / setup (existing inventory)
- Optional compact **project** banner for list/connect errors ([slop plan](./contributor-experience-and-slop-removal.md)) — **not** on PromptBox `disabled`

| Readiness signal             | Affects                                                                    |
| ---------------------------- | -------------------------------------------------------------------------- |
| CLI missing                  | Harness row in dialog: “not installed”; still selectable to show help text |
| Auth / no models for harness | No provider sections; harness-level empty copy + Settings link             |
| `loadResources` in flight    | Step 2 spinner inside dialog only                                          |
| One harness failed hydration | Other harnesses in step 1 unchanged                                        |

**Model-ready Harness** ([CONTEXT](../../CONTEXT.md)): required to **send** with that harness, not to keep PromptBox enabled.

---

## Current code to replace / refactor

| Area                      | Today                                                                 | Target                                                                     |
| ------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `ModelSelector.tsx`       | Model trigger; harness chips in dialog; `return null` if no providers | `HarnessModelSelector` (or refactor): 2-step dialog; always render trigger |
| `use-agent-backend.ts`    | `useCurrentHarnessId()` from storage                                  | Derive active harness from PromptBox selection + session lock              |
| `ModelSelector` + routing | `setActiveTargetBackend` on chip click                                | `setPromptBoxSelection({ harnessId, model })`                              |
| `App.tsx`                 | `disabled={isBooting \|\| isLoadingMessages}`                         | Do not disable textarea for load/boot (optional: disable Send only)        |
| `agent-local-intent.ts`   | English errors, partial model gate                                    | Gate on `harnessId` + `selectedModel`; i18n                                |
| `loadServerResources`     | Tied to routed harness                                                | Run for dialog-selected harness + active directory                         |

---

## Implementation tracks

### T1 — Selection state & routing

- [x] `prompt-box-selection.ts`: `resolvePromptBoxHarnessId`, `hasPromptBoxSelectionForSend`, `resolveHarnessIdForSend`.
- [x] Reducer: `SET_PROMPT_BOX_HARNESS`, `SET_PROMPT_BOX_SELECTION`; actions `setPromptBoxHarness`, `setPromptBoxSelection` (persist `STORAGE_KEYS.HARNESS`).
- [x] `sendPromptToAgent` / `sendCommandToAgent`: `assertAgentSendSelection`; pending send uses `activeTargetHarnessId` + fallback.
- [x] Deprecate separate “preferred harness” UX in UI (storage remains bootstrap fallback only).

### T2 — Selection dialog (Harness → Provider → Model)

- [x] Step 1: list `HARNESS_IDS` / registry labels + per-harness readiness from inventory + scoped catalog hint.
- [x] Step 2: `loadResources({ harnessId, target: { directory, … } })` when harness or directory changes.
- [x] Step 3: Filter `providers[]` to **only providers with ≥1 model**; then group (provider header → models). Reuse `groupModelsByProvider` / search on filtered set.
- [x] Trigger label shows harness + model; never `return null` on empty catalog.
- [x] i18n `en`, `de`, `es`.

### T3 — PromptBox chrome & send gate

- [x] Remove harness chips from old dialog; no new PromptBox widgets.
- [x] Send + Enter: require harness + model; open selection dialog if incomplete.
- [x] Remove `isLoadingMessages` / `isBooting` from textarea `disabled`.

### T4 — Harness errors (adjacent, not PromptBox)

- [x] `sessions.query` `errors[]` → project/harness status (sidebar or above queue).
- [x] Terminology: Harness errors, not “agent backend” ([ADR 0001](../adr/0001-harness-terminology.md)).

### T5 — CONTEXT & docs

- [x] Add glossary entry **Provider (Harness catalog)** if needed: “grouping of models reported by a Harness for a project scope; not Provider credentials alone.”
- [x] Clarify **PromptBox selection** bullet: explicitly includes **Harness** + model within **Provider** section of the selector.
- [x] Link from [`contributor-experience-and-slop-removal.md`](./contributor-experience-and-slop-removal.md).

---

## Acceptance (manual)

1. Project connected; Pi has no providers with models; Codex does → PromptBox **not** gray; selector → Codex → only non-empty provider sections → pick model → send works.  
   1b. Harness selected but every provider has 0 models → no provider headers; harness-level empty state only.
2. Never pick a model → can type; Send does not dispatch.
3. PromptBox strip shows **one** selection control (no harness pills).
4. Active session → harness locked inside dialog; model change allowed if harness supports multiple models per policy.
5. Message load / boot → textarea stays enabled.

---

## Verification

```bash
pnpm vp check
pnpm vp test
pnpm run slop-check
```

---

## Suggested PR order

**T1 → T2 → T3 → T4 → T5** (T2 is the main UX; T1 unblocks honest routing)

---

## References

- [CONTEXT.md](../../CONTEXT.md) — Harness, Provider credentials, PromptBox selection, Model-ready Harness
- [`ModelSelector.tsx`](../../src/components/ModelSelector.tsx)
- [`agent-harness-routing.ts`](../../src/hooks/agent-harness-routing.ts)
- [`use-agent-impl-core.tsx`](../../src/hooks/use-agent-impl-core.tsx) (`loadServerResources`)
