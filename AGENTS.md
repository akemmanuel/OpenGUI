Default to using Vite+ (`vp`) instead of raw runtime or package-manager commands.

- Use `pnpm run dev` for desktop development (Electron)
- Use `pnpm run dev:web` for web development (browser)
- Use `pnpm run start` / `pnpm run start:web` for production runs
- Use `vp check` for lint, format, and type checks
- Use `vp lint` for lint only
- Use `vp fmt` for format only
- Use `vp test` for tests
- Use `vp build` for production build
- Use `vp run <task>` for project tasks
- Use `vp exec <command>` for local binaries
- Use `node --experimental-strip-types <file>` for project TypeScript scripts (or `vp node` when Vite+ env shims are installed)
- Use `vp dlx <package> <command>` for one-off package binaries
- Use `vp cache` for task cache
- Use `pnpm install` to install dependencies
- Use `pnpm add`, `pnpm remove`, `pnpm update`, etc. for dependency changes
- Use `pnpm run <script>` for package scripts
- Do not use `npm` or `yarn` in project instructions unless code specifically requires them.

## Development

Run the app with `pnpm run dev` (Electron) or `pnpm run dev:web` (browser). Use Vite+ (`vp`) for lint, format, typecheck, test, and build—not for choosing dev vs prod.

## Code quality

- Run `pnpm run slop-check` when changing server session paths, `OpenGuiClient`, or harness registry
- Prefer `vp check` before submit
- Prefer `vp lint` / `vp fmt` when narrowing issues
- Use `pnpm run` only when task is defined in `package.json`

## Translations

When adding or changing user-facing text, update i18n files in `src/i18n/locales/` at same time.

- Add or update keys in `en.json`, `de.json`, and `es.json`
- Do not leave hardcoded UI strings in React components when text should be translated
- Keep locale key structure aligned across all supported languages

## Project notes

- `vite.config.ts` uses `vite-plus`
- `packageManager` is `pnpm@11.5.2`
- Keep docs aligned with Vite+ / pnpm workflow

## NEVER RUN

Never use tsc for typechecking
