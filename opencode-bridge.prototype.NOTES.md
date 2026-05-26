# OpenCode bridge prototype notes

Question:

- How does provider listing/auth/connect/OAuth behave when `OpenCodeConnection` is imported directly?

Run:

- `pnpm run prototype:opencode-bridge`
- with auth: `OPENCODE_BASE_URL=... OPENCODE_USERNAME=... OPENCODE_PASSWORD=... pnpm run prototype:opencode-bridge`

Warning:

- This prototype talks to a live OpenCode server.
- `connect` / `disconnect` mutate provider auth on that server.

Verdict:

- TODO after using the prototype.
