# OpenGUI browser bug hunt

Date: 2026-07-23  
Target: `pnpm run dev:web` at `http://127.0.0.1:5173`  
Browser: Chromium through `agent-browser`  
Viewports: 1440×900 and 390×844

## Summary

- Fixed: 3 defects (1 keyboard/focus, 1 accessibility semantics, 1 provider form integrity).
- Regression coverage added: 6 focused assertions across 3 new test files.
- Frontend suite: 68 files / 273 tests passed.
- Full `pnpm run check`: passed.
- No paid or live model requests were made.

## Fixed defects

### BH-001 — Setup wizard leaked keyboard focus into the app behind it

**Severity:** High accessibility / interaction defect

**Reproduction before fix**

1. Complete first-owner Host setup so the onboarding wizard opens.
2. Leave **Connect a model** open.
3. Press `Tab`.
4. Focus moved through the background PromptBox controls: **Add**, model selector, reasoning selector, and context window before reaching wizard controls.

Evidence: [`screenshots/model-setup-overlay.png`](screenshots/model-setup-overlay.png)

**Root cause**

The wizard was a visual fixed-position overlay, not the shared modal primitive. In addition, `PromptBox` unconditionally ran its autofocus effect while onboarding was open, overriding modal initial focus.

**Fix**

- `src/components/SetupWizard.tsx`: compose the shared Base UI `Dialog`, `DialogContent`, and `DialogTitle`, gaining modal semantics, inert background handling, Escape behavior, and focus trapping.
- `src/App.tsx`: suppress PromptBox autofocus while setup is suppressing the underlying boot surface.

**Regression test**

- `src/components/SetupWizard.focus.architecture.test.ts` locks the cross-component focus-isolation wiring.
- Browser recheck: initial focus is the Base URL field; after ten `Tab` presses focus remains in the dialog.

Evidence after fix: [`screenshots/setup-focus-fixed.png`](screenshots/setup-focus-fixed.png)

### BH-002 — Static Session titles were announced as editable textboxes

**Severity:** Medium accessibility defect

**Reproduction before fix**

On a sidebar with ten resting Session rows:

```text
agent-browser get count '[role=textbox]'
10
```

The rows were not in rename mode, but each title span explicitly had `role="textbox"` and `tabIndex=-1`. The accessibility snapshot consequently exposed every static Session title as a textbox.

**Root cause**

The non-editing branch in `SessionRow` carried editing semantics. The real rename branch already renders an actual `<input>` and did not need this role on resting text.

**Fix**

- `src/components/sidebar/SessionRow.tsx`: extracted `SessionRowTitle` and removed the false textbox role/tab stop from its resting state.

**Regression test**

- `src/components/sidebar/SessionRow.test.tsx` renders the public title seam and asserts that text remains visible without `role="textbox"`.
- Browser recheck returned `0` false textboxes while the actual message composer remained correctly exposed separately.

### BH-003 — Provider submit seam accepted structurally empty connections

**Severity:** Medium configuration-integrity defect

**Reproduction before fix**

The custom connection handler constructed and submitted a connection even when trimmed Base URL or model ID was empty. The button attempted to prevent this visually, but the handler itself had no guard, leaving race/programmatic submission paths able to persist an unusable connection.

**Root cause**

Validation existed only in the button's `disabled` expression and was not part of the submit operation's data boundary.

**Fix**

- `src/components/SettingsProviders.tsx`: added `buildCustomModelConnection`, which trims values and returns `null` unless endpoint and model are present; the submit handler exits before calling the Host for invalid input.

**Regression test**

- `src/components/SettingsProviders.test.ts` went red on empty endpoint/model, then green after the guard. It also locks normalization of a valid Host payload.

## Exercised journeys

- First-owner Host setup, password mismatch validation, and successful account creation.
- First-run model/folder/finish wizard, Skip/Back/Continue/Close, focus cycling, and Escape behavior.
- Empty chat composer and disabled send state.
- Sidebar expanded/collapsed and mobile sheet behavior.
- Project picker opening, server directory listing, cancel/Escape, and focus restoration.
- Settings General, Providers, and Team tabs.
- Provider list, custom connection form, ownership plane, entitlement switches, and invalid required fields.
- Model selector opening, search surface, reasoning controls, and dialog close behavior.
- Desktop and 390×844 mobile layouts.
- Refresh and frontend presentation persistence.
- Browser offline reload behavior and recovery after restoring connectivity.
- Console, page errors, and API network requests checked throughout.

Screenshots:

- [`screenshots/setup-initial.png`](screenshots/setup-initial.png)
- [`screenshots/setup-folder-web.png`](screenshots/setup-folder-web.png)
- [`screenshots/settings-general.png`](screenshots/settings-general.png)
- [`screenshots/settings-providers.png`](screenshots/settings-providers.png)
- [`screenshots/settings-providers-mobile.png`](screenshots/settings-providers-mobile.png)

## Remaining findings / blocked journeys

1. **Collapsed sidebar exposes invisible controls to keyboard/accessibility navigation.** The opacity-hidden **Add project** control remains in the accessibility tree while the sidebar is icon-collapsed. Activating that invisible instance is a no-op; expanding the sidebar and activating the visible control correctly opens the server folder dialog. This should be fixed with collapsed-state visibility/focus semantics and a sidebar regression test.
2. **Sidebar rows contain nested interactive semantics.** Session/project row buttons include pin/menu buttons (and project drag/rename controls), causing accessible names such as “hi Pin to top” and nested buttons in snapshots. A follow-up should separate the row activation target from sibling actions rather than hiding those actions from assistive technology.
3. **Web setup shows a Browse button backed by a desktop shell picker.** In the Web Shell's setup folder step, Browse produces no result or explanation. The normal Add Project flow correctly uses the Host folder browser. Setup should use the same Host path seam or omit Browse on Web.
4. **True in-app disconnected state could not be exercised with Chromium offline mode.** Reloading while fully offline navigates to Chromium's built-in offline error before cached app code runs. Deterministic API-route failure E2E coverage would require maintainable request interception or a dedicated fake Host.
5. **Paid/live provider journeys intentionally blocked:** Codex/ChatGPT OAuth, xAI sign-in, credential validation, model streaming, tool calls, queues during a real run, and provider outage responses were not executed.
6. **Invite/member/share journeys require additional accounts or deterministic identity fixtures.** Owner Team surfaces were inspected, but invite acceptance, member path grants, private Session visibility, run ACLs, and public view links were not mutated in this shared development Host.

## Verification commands

```text
pnpm vp test src/components/SetupWizard.test.ts src/components/SetupWizard.focus.architecture.test.ts src/components/sidebar/SessionRow.test.tsx src/components/SettingsProviders.test.ts
  4 files passed, 6 tests passed

pnpm run test:frontend
  68 files passed, 273 tests passed

pnpm run check
  formatting, lint, and type checks passed
```
