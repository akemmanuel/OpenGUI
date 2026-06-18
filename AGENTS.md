Default to using Vite+ (`vp`) instead of raw runtime or package-manager commands. Vite+ is a dev dependency: use **`pnpm vp <command>`** when `vp` is not on `PATH`, or **`pnpm run <script>`** when `package.json` defines the task.

- Use `pnpm run dev` for desktop development (Electron); use `pnpm run dev:web` for web (append `:web` to the dev task)
- Use `pnpm run start` for desktop production; use `pnpm run start:web` for web (append `:web` to the start task)
- Use `pnpm vp check` (or `pnpm run check`) for lint, format, and type checks
- Use `pnpm vp lint` (or `pnpm run lint`) for lint only
- Use `pnpm vp fmt` (or `pnpm run fmt`) for format only
- Use `pnpm vp test` (or `pnpm run test`) for tests
- Use `pnpm run build` for production build
- Use `pnpm vp run <task>` or `pnpm run <script>` for project tasks
- Use `pnpm vp exec <command>` for local binaries
- Use `node --experimental-strip-types <file>` for project TypeScript scripts (or `pnpm vp node` when Vite+ env shims are installed)
- Use `pnpm vp dlx <package> <command>` for one-off package binaries
- Use `pnpm vp cache` for task cache
- Use `pnpm install` to install dependencies
- Use `pnpm add`, `pnpm remove`, `pnpm update`, etc. for dependency changes
- Use `pnpm run <script>` for package scripts
- Do not use `npm` or `yarn` in project instructions unless code specifically requires them.

## Development

Run the app with `pnpm run dev` or `pnpm run start` on desktop; for the browser stack, use the same task with `:web` (`pnpm run dev:web`, `pnpm run start:web`). Use Vite+ (`vp`) for lint, format, typecheck, test, and build—not for choosing dev vs prod.

## Code quality

- Run `pnpm run slop-check` when changing server session paths, `OpenGuiClient`, or harness registry
- Prefer `pnpm vp check` before submit
- Prefer `pnpm vp lint` / `pnpm vp fmt` when narrowing issues
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
