# OpenGUI reasoning-effort dogfood report

**Target:** `http://127.0.0.1:5173`  
**Scope:** Reasoning-effort discovery, selection, persistence, responsive layout, and Host synchronization  
**Result:** No remaining reproducible issues in the tested scope

## Resolved findings

### ISSUE-000 — Model reasoning output was discarded

The Host previously sent an effort setting but discarded reasoning fields from both Responses API and Chat Completions streams. It now requests reasoning, streams it through the Harness and Host event protocols, persists it as `assistant_reasoning`, and projects it as an expandable Thinking part beside the final answer.

Evidence: [reasoning-output-expanded.png](screenshots/reasoning-output-expanded.png)

### ISSUE-001 — Reasoning control was not identifiable

The trigger displayed only the selected value (for example, “Medium”), so it was easy to miss or mistake for another model setting. It now displays an explicit label such as **Reasoning: High**.

Evidence: [reasoning-explicit.png](screenshots/reasoning-explicit.png)

### ISSUE-002 — models.dev endpoint omitted provider-specific effort options

The provider-agnostic catalog exposed reasoning capability but omitted `reasoning_options`. The integration now uses the provider catalog and offers only the model's published options.

Evidence: [reasoning-all-efforts.png](screenshots/reasoning-all-efforts.png)

### ISSUE-003 — Extended reasoning efforts were rejected

The Host accepted only off/low/medium/high, while models.dev also publishes minimal, extra-high, and maximum. The protocol, route validation, Harness, and UI now support all published normalized effort values.

Evidence: [reasoning-session-persisted.png](screenshots/reasoning-session-persisted.png)

### ISSUE-004 — Reasoning menu stayed open after selection

Radio items now close the menu after an effort is selected.

### ISSUE-005 — Backend did not restart after package changes in development

The Vite watcher compared relative paths only against slash-prefixed patterns. Backend package changes now reliably restart the development Host.

## Verification performed

- Reasoning trigger is visible on desktop and mobile widths.
- Menu opens without Base UI context errors.
- models.dev options for `deepseek-v4-flash-free` render as Off, High, and Maximum.
- Selecting an effort closes the menu.
- Existing-session changes are persisted by the Host (`reasoning: max` verified through the Host API).
- Session and default effort survive page reloads.
- Failed Host updates roll the optimistic UI state back and surface an error.
- A clean browser session showed no console errors during the final interaction pass.
