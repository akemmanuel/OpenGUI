# Responsive regression gate

Run the production-style responsive gate with:

```sh
pnpm run test:responsive
```

The command provisions the project-pinned `agent-browser` Chrome binary, starts an isolated temporary OpenGUI Host, fake model provider, Vite browser app, and fresh browser profiles, then removes the temporary data and processes. It does not use a developer's existing Host or browser state.

## Coverage

The gate cross-checks English, German, and Spanish with a fixed-seed matrix spanning 280–1200 CSS px. It includes short-landscape heights, 100–200% root text scaling, DPR 1–3, coarse and fine-pointer contracts, simulated safe-area insets, reduced motion, and keyboard-only focus traversal. The scenarios cover Host account setup, the model Setup Wizard, owner and member empty states, a running/loading Session, long populated and provider-error transcripts, general/provider/Team settings (including members, invites, path grants, and API-key forms), a share dialog, a view-only member, a populated public read-only link, and a public-link error.

Fixtures include long Project paths, Session titles, model names, errors, URLs, Markdown tables and code, unbroken words, combining characters, emoji, CJK, and RTL-like runs.

The recursive DOM audit reports the rule, selector, visible text, bounding rectangle, scroll/client dimensions, and viewport. It checks root and element overflow, clipping, viewport escape, dialogs and sheets, accessible control names, transparent hover-only actions, reliable actionable-control overlap, and 44×44 coarse-pointer targets.

Before the application matrix, Chromium synthetic red/green fixtures prove the detector against viewport escape, nested flex min-content overflow, clipped text, offscreen portals, transforms, fixed overlays, scroll containers, hidden elements, coarse hit areas, and overlapping controls. Adversarial fixtures also cover `body` overflow masking, zero-size ancestors, broad ancestor exemptions, unknown/stale exemption names, and native text-editor scrolling.

## Explicit responsive contracts

`data-responsive-allow` keeps intentional exceptions local and reviewable:

- `horizontal-scroll`: a deliberately scrollable code, table, or tab surface.
- `text-clip`: deliberate single-line truncation where the full value remains available through surrounding context or a title.
- `hover-reveal`: a fine-pointer hover action that is also keyboard-focusable and is forced visible by the coarse-pointer contract.
- `compact-target overflow-visible`: a compact switch or slider whose pseudo-element supplies a 44×44 hit area.
- `action-overlap` and `viewport-escape`: reserved for a reviewed exceptional geometry; none are currently used.

Do not add a global `overflow-x: hidden` rule. Fix the component's sizing or wrapping first. Intentional horizontal scrolling must use `horizontal-scroll` on the owning element.

## Browser and device limits

The deterministic CI gate runs Chromium. `agent-browser` cannot independently override the CDP pointer media feature, so the test sets `data-responsive-coarse` as an explicit equivalent while production CSS also uses `(pointer: coarse)`. Root font scaling is used instead of browser chrome zoom. Screenshots are captured only on failure; pixel snapshots are intentionally omitted because font rasterization is not stable across CI images.

Before release, test a real iPhone/Safari and Android/Chrome for WebKit layout, dynamic browser chrome, virtual keyboards, notches/home indicators, native Capacitor WebViews, OS font scaling, and real touch hit behavior. Those native-only behaviors cannot be certified by this Chromium DOM gate.
