# First-party Harness UI preservation baseline

Captured before application-source migration on 2026-07-10. The browser captures are stored in `/tmp/opengui-baseline/` in the migration workspace. They are working evidence, not product assets.

## Captured states

| Capture                              |  Viewport | SHA-256                                                            |
| ------------------------------------ | --------: | ------------------------------------------------------------------ |
| `01-setup.png`                       | 1440×1000 | `abc64ea9c4db1eeb97d722a2a058a4f735e229e6a8a0a191d05bca485b132e79` |
| `02-setup-default-directory.png`     | 1440×1000 | `d1187c7de5589b664b0fe6114ef97670801686322977fe80c43f480f4387647c` |
| `03-setup-ready.png`                 | 1440×1000 | `2f4a5e9195983e120ade9e4f3dc02ce5bf649655bbe651694245ac26bf3770e3` |
| `04-project-sidebar.png`             | 1440×1000 | `f77340c856657049c6a857e1abb89b3f3782647b23e29312693391934c389f35` |
| `05-empty-session.png`               | 1440×1000 | `18ff27e652b35d38d3d0d1dfd7b0f21fcaacaf9e5667f185af00fd8a99965680` |
| `06-prompt-model-selector.png`       | 1440×1000 | `a93989da872a83b1965fa6bca6f9ed4d115fca14864ceacd6323eb9033a5347c` |
| `07-settings-general.png`            | 1440×1000 | `f9bccd4833480b61490911a6ee4836949e7ec5373fad2955f339d53ac48ea5a3` |
| `08-settings-providers.png`          | 1440×1000 | `e9be93ee3b834e161da6bc55a752bd44745716c7553d8fe2b0ab12584f4ff465` |
| `09-active-transcript-reference.png` |  1202×798 | `b36cd983a7270c131caffa04f5db74c8ada9715d549763378afe2c1da8c1e30a` |
| `10-mobile-session.png`              |   390×844 | `45c69130096747bc7993218ce434c4ff581d689e6bdd59d4f1ba552b94038a5d` |

Captures 01–08 and 10 came from the restored app through browser automation. Capture 09 is a copy of the tracked `screenshot.png`, retained as the active transcript/tool-call reference because the clean browser profile had no external-Harness transcript to open.

## Protected visual surfaces

Treat these as preservation surfaces during orchestration cutover. Subtractive removal of obsolete controls is allowed; replacement visual modules are not.

- `styles/globals.css`
- `src/App.tsx`, `src/components/TitleBar.tsx`, and `src/components/AppSidebar.tsx`
- `src/components/sidebar/**`, especially `ProjectEntry.tsx` and `SessionRow.tsx`
- `src/components/MessageList.tsx`, `src/components/message-list/**`, and `src/components/MarkdownRenderer.tsx`
- `src/components/PromptBox.tsx`, `PromptAddMenu.tsx`, `PromptImageMentions.tsx`, `PromptContextStatus.tsx`, and `PromptSessionStatus.tsx`
- `src/components/settings/**` and `src/components/SetupWizard.tsx`
- `src/components/ui/**`
- theme, responsive-shell, notification, dialog, upload, mention, draft, and queue presentation modules called by those surfaces

Keep `git diff -- src/components styles/globals.css` empty during independent Harness work. For each Frontend tranche, recapture the same states and compare hierarchy, dimensions, density, transcript rendering, scrolling, settings structure, and responsive behavior.
