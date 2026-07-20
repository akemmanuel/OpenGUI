# Slop Cleanup Plan

Based on a thorough audit of the codebase. Items ranked by impact × effort.

---

## 1. 🔴 70 i18n Locales (38,582 lines of mostly machine-translated JSON)

**Files:** `src/i18n/locales/*.json` (70 files)
**Problem:** The app has translations for 70 languages. The English/Spanish/German ones are 689 lines each; the other 67 are 545 lines each. Most are likely machine-translated, incomplete, and barely (if ever) used. This bloats the bundle and adds enormous maintenance drag (every new UI string needs to be translated 70 ways).
**Fix:**

- Cut to the top 5–10 languages that have actual human translation quality (en, es, de, fr, zh, ja, pt, etc.)
- Keep English as authoritative; add others via community PRs, not bulk machine translation
- Move locale loading to dynamic imports so unused languages aren't bundled

---

## 2. 🔴 6 Empty Feature Directories (Dead scaffolding)

**Paths:**

- `src/features/worktree/`
- `src/features/agent-workspaces/`
- `src/features/agent-sessions/`
- `src/features/agent-resources/`
- `src/features/agent-provider-shell/`
- `src/features/agent-projects/`

**Problem:** All six directories are completely empty — not even a `.gitkeep`. They were created as future extension points but never filled. They clutter the tree and mislead contributors.
**Fix:** Delete all six directories.

---

## 3. 🔴 `HostProvider.tsx` — 886-line monolithic god component

**File:** `src/features/host-provider/HostProvider.tsx`
**Problem:** Manages workspace state, project connections, session lifecycle, model selection, transcript hydration, action dispatching, and provides 4 React contexts. ~30 `useState` + `useRef` + `useCallback` + `useEffect` calls. The `actions` useMemo has 30+ dependencies.
**Fix:**

- Extract workspace management into `useWorkspaces.ts`
- Extract project/session management into `useHostSessions.ts`
- Extract action object creation into `useHostActions.ts`
- Keep `HostProviderBody` as a thin orchestrator

---

## 4. 🟠 `agent-contexts.ts` — Three massive context interfaces (153 lines)

**File:** `src/hooks/agent-contexts.ts`
**Problem:** `SessionContextValue`, `ModelContextValue`, `ConnectionContextValue`, and `ActionsContextValue` are huge interfaces with 15–40 fields each. Any tiny change re-renders every consumer.
**Fix:**

- Split into smaller focused contexts (e.g., `SessionListContext`, `ActiveSessionContext`, `ModelCatalogContext`, `WorkspaceContext`)
- Use selector patterns or `useSyncExternalStore` to minimize re-renders

---

## 5. 🟠 `agent-state-types.ts` — Central state blob (127 lines)

**File:** `src/hooks/agent-state-types.ts`
**Problem:** `InternalAgentState` has ~30 fields covering everything from workspaces to draft maps to after-part triggers.
**Fix:** Break into logical sub-states: `WorkspaceState`, `SessionCollectionState`, `ModelCatalogState`, `UIState`, etc.

---

## 6. 🟠 `types/electron.d.ts` — Dumping ground (238 lines)

**File:** `src/types/electron.d.ts`
**Problem:** Mixes provider management types, connection status, workspace config, shell API contracts, settings bridge, Electron preload types — all in one file.
**Fix:** Split into:

- `src/types/provider.ts` — ProviderAuth, AllProvidersData, etc.
- `src/types/connection.ts` — ConnectionStatus, ConnectionConfig
- `src/types/workspace.ts` — Workspace, WorkspaceSettings
- `src/types/shell.ts` — ShellAPI, ElectronAPI
- `src/types/settings.ts` — SettingsBridge, SettingsBridgeChange

---

## 7. 🟠 `safe-storage.ts` — Too many storage variations (181 lines)

**File:** `src/lib/safe-storage.ts`
**Problem:** 8 public functions for reading/writing settings: `storageGet`, `storageSet`, `storageRemove`, `storageParsed`, `storageSetJSON`, `storageSetOrRemove`, `persistOrRemoveJSON`. Plus localStorage mirroring + bridge caching + custom events.
**Fix:**

- Remove `storageSetOrRemove` and `persistOrRemoveJSON` (thin convenience wrappers)
- Collapse `storageParsed`/`storageSetJSON` into the base functions with generics
- Remove localStorage mirroring if SettingsBridge is always available in practice

---

## 8. 🟠 `utils.ts` — Dumping ground (341 lines)

**File:** `src/lib/utils.ts`
**Problem:** Contains unrelated utilities: Tailwind class merging, path abbreviation, semver comparison, clipboard, UUID generation, a 100-line ANSI escape code parser, git PR URL builder, time formatting, token computation, etc.
**Fix:**

- Move `normalizeTerminalOutput` → `src/lib/terminal.ts`
- Move `buildPRUrl` → `src/lib/git.ts` or inline where used
- Move `formatTimeAgo`, `computeTokenTotal` to domain modules
- Keep `cn`, `abbreviatePath`, `compareSemver`, `findModel`, `getPrimaryAgents`, `getErrorMessage`, `copyTextToClipboard`, `createUuid` in utils

---

## 9. 🟠 Duplicate type definitions across layers

**Problem:** `SelectedModel`, `Workspace`, `ConnectionStatus` are defined in `electron.d.ts`, while `HostModelConnection`, `HostSessionSummary`, etc. live in `host-types.ts`. Similar concepts exist in `agent-state-types.ts` (e.g., `Session` extends the base type). This leads to type drift and confusing conversions.
**Fix:**

- Establish a single source of truth per domain concept
- Remove the extension pattern in `agent-state-types.ts`; use intersection types or pick from canonical types

---

## 10. 🟡 `TitleBar.tsx` — 547 lines with DnD logic embedded

**File:** `src/components/TitleBar.tsx`
**Problem:** Contains inline drag-and-drop sortable workspace tab logic (`@dnd-kit`), which adds ~150 lines of DnD boilerplate to a component that's primarily about window controls.
**Fix:** Extract workspace tab sorting into a separate `SortableWorkspaceTabBar.tsx` component.

---

## 11. 🟡 `SidebarItemMenus.tsx` — 514 lines

**File:** `src/components/SidebarItemMenus.tsx`
**Problem:** Large component with hardcoded color pickers, inline context menu logic, and session color definitions. The `SESSION_COLORS` array is in the same file as the render logic.
**Fix:** Extract `SessionColorPicker` sub-component; move color definitions to a constants file.

---

## 12. 🟡 `normalizeTerminalOutput` in utils.ts — 100+ line ANSI parser used exactly once

**File:** `src/lib/utils.ts` (function `normalizeTerminalOutput`)
**Problem:** A complex terminal escape code parser is buried in a general utility module and used in exactly one place (`App.tsx` for `normalizedBootLogs`).
**Fix:** Extract to `src/lib/terminal.ts` as suggested above.

---

## 13. 🟡 90 provider icon SVGs in `src/components/provider-icons/svgs/`

**File:** `src/components/provider-icons/svgs/*.svg` (90 files)
**Problem:** Inline SVG files for AI provider logos. Many may be unused. They clutter the source tree.
**Fix:** \n- Audit which are actually referenced from `provider-icons/types.ts` or the icon resolver\n- Remove unused SVGs\n- Consider lazy-loading or a spritesheet approach\n\n---\n\n## 14. 🟡 `@opengui/harness` package consumption\n\n**Files:** `packages/harness/src/`\n**Problem:** The harness package has significant code (tool implementations, models, skills, storage) but is never imported in `src/` or `packages/backend/`. It may be dead code retained from an earlier architecture.\n**Fix:** Verify whether any consumer imports it. If none, remove the package entirely or mark it as explicitly unused.\n\n---\n\n## Summary Table\n\n| # | Area | Effort | Impact | Lines affected |\n|---|------|--------|--------|----------------|\n| 1 | i18n locales | Low | High | 38,582 |\n| 2 | Empty feature dirs | Trivial | Medium | 6 dirs |\n| 3 | HostProvider.tsx | High | High | 886 |\n| 4 | agent-contexts.ts | Medium | High | 153 |\n| 5 | agent-state-types.ts | Medium | High | 127 |\n| 6 | electron.d.ts | Medium | Medium | 238 |\n| 7 | safe-storage.ts | Medium | Medium | 181 |\n| 8 | utils.ts | Medium | Medium | 341 |\n| 9 | Duplicate types | Medium | Medium | various |\n| 10 | TitleBar.tsx | Low | Low | 547 |\n| 11 | SidebarItemMenus.tsx | Low | Low | 514 |\n| 12 | terminal parser | Low | Low | 100+ |\n| 13 | Provider SVGs | Low | Low | 90 files |\n| 14 | Unused harness pkg | Low | Medium | ~2K |\n\n---\n\n## Suggested execution order\n\n1. **Quick wins** (trivial-to-low effort, visible reduction): Items 2, 12, 13, 14\n2. **High visible impact** (large line count reduction): Item 1\n3. **Medium refactors** (improve maintainability): Items 6, 7, 8, 9, 10, 11\n4. **Architecture improvements** (higher risk, higher reward): Items 3, 4, 5\n
