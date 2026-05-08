Default to using Vite+ (`vp`) instead of raw Bun commands.

- Use `vp dev` for development
- Use `vp check` for lint, format, and type checks
- Use `vp lint` for lint only
- Use `vp fmt` for format only
- Use `vp test` for tests
- Use `vp build` for production build
- Use `vp run <task>` for project tasks
- Use `vp exec <command>` for local binaries
- Use `vp node <file>` for Node.js scripts
- Use `vp dlx <package> <command>` for one-off package binaries
- Use `vp cache` for task cache
- Use `pnpm install` to install dependencies
- Use `pnpm add`, `pnpm remove`, `pnpm update`, etc. for dependency changes
- Use `pnpm run <script>` for package scripts
- Do not use `bun`, `npm`, or `yarn` in project instructions unless code specifically requires them.

## Development

Use Vite+ task runner and pnpm-managed deps.

## Code quality

- Prefer `vp check` before submit
- Prefer `vp lint` / `vp fmt` when narrowing issues
- Use `pnpm run` only when task is defined in `package.json`

## Project notes

- `vite.config.ts` uses `vite-plus`
- `packageManager` is `pnpm@10.33.4`
- Keep docs aligned with Vite+ / pnpm workflow
