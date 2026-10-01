# Instructions

Settings → Instructions has three scopes:

- **Host:** the existing Host-wide text. Everyone can read it; human owners/admins can edit it. Desktop Local can edit without an account.
- **Project:** one shared text per registered, canonical project directory. All users with project read access see the same text. It is stored in Host state, not written into the repository.
- **Personal:** private preferences per user on this Host. Only that user can read or edit them through the API. Desktop Local has one account-free personal scope. API keys do not inherit their issuer's preferences.

The prompt contains Host, Project, then Personal sections. Its conflict guidance gives Host priority over Project and Project priority over Personal. This is guidance to the model, not a security mechanism. Filesystem, Session, model and tool authorization remain enforced separately. Personal instructions are sent to the model provider and may affect responses in shared Sessions; never put secrets in them.

Teams have no instruction text. Owners/admins manage a per-project list of teams whose members may edit the shared project text. This uses existing Host administrator roles; there is no new team-lead role. If any of a member's teams is allowed, that member can edit. A team without an allow grants nothing. Everyone is the implicit team of all Host members, so allowing Everyone enables all members with project access. Viewers and API keys cannot edit through team permissions. Human owners/admins can always edit projects they can access.

Project permissions never grant filesystem access. Membership, role and project read access are checked on every request. Team removal, membership changes, permission changes and revoked path grants therefore affect subsequent requests immediately. There are no private copies of shared project instructions.

Instructions are resolved using the actor requesting each turn, including queued prompts and manual compaction. Changes apply on the next turn; an already running turn keeps its assembled prompt. Each text has the existing 32,000-character limit. Text is never silently truncated. Larger combined instructions consume more model context.

## Persistence and API

Existing `customInstructions` remains the Host source of truth in `opengui-host-state.json`. The additive `scopedInstructions` field stores personal text and project text/team edit permissions. Older Host state loads with empty new scopes. Updates use the existing durable JSON transaction, preserving other scopes and concurrent policy/text changes. A project is identified by its canonical directory; moving to a different directory creates a different instruction scope. Unregistering a project hides it but retains its instructions for re-registration.

The existing `GET/PUT /api/host/custom-instructions` endpoint is unchanged. New authenticated endpoints:

- `GET/PUT /api/host/personal-instructions` (PUT body: `{ text }`). Identity always comes from authentication, never a body or query user ID.
- `GET /api/host/project-instructions?directory=…` returns `{ directory, text, canEdit, canManage, teams }`. Only administrators receive the team edit controls.
- `PUT /api/host/project-instructions` (body: `{ directory, text }`).
- `PUT /api/host/project-instructions/editors` (body: `{ directory, teamId, allowed }`). Administrators only; the team must exist.

Editors preserve failed-save drafts, confirm before discarding unsaved text, and show server-provided project permissions. All scope labels and permission explanations are translated into English, German and Spanish.
