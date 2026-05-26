# Pi bridge prototype notes

Question:

- How does provider listing/auth/connect/OAuth behave when `PiBridgeManager` is imported directly?

Run:

- `pnpm run prototype:pi-bridge`
- fallback: `node --experimental-strip-types ./pi-bridge.prototype.ts`

Expected takeaway:

- Validate the bridge method surface quickly from a terminal.
- This prototype snapshots `~/.pi/agent/auth.json` on start and restores it on exit.

Verdict:

- TODO after using the prototype.
