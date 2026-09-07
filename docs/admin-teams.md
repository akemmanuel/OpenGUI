# People, Teams, and model access

Remote Host owners and admins manage named Teams in **Settings → Teams**. Desktop Local remains Account-free.

## Create a Team

Select **Create team**, enter a name, and select existing Host members. The **Models** tab grants shared models to the Team. **Personal connections** controls whether members may use personal API keys or supported subscription credentials. Select **Save changes** to save membership, model grants, and policy together.

Invite new Accounts under **People** before adding them to a named Team. Team membership does not change Host roles or grant paths or Sessions automatically.

**Everyone** is the existing `host_default` principal. It includes current and future Host members and cannot be renamed or deleted. Existing grants and policy remain attached to it after upgrading.

## Model access

**Models → Manage access** edits direct Account grants and Team grants. Changes remain a local draft until saved. A failed save keeps the draft for retry; Cancel restores the last saved values.

Account and Team grants are additive. Removing a direct grant does not remove access through a Team. Host owners and admins can manage and use shared models regardless of these grants. **People → View access** shows each person's Teams and shared model access sources.

Provider URLs, upstream model IDs, and credentials belong in **Provider connections**, separate from the shared model list.

## Personal credentials

Restrictions take priority. System, Everyone, or any named Team the Account belongs to can disable personal API keys or subscriptions. A Team cannot override a restriction from another scope. These settings govern supported credential types; they do not add new provider authentication integrations.

The Host checks effective policy when creating personal model connections and when authorizing their use. Disabling a credential type also prevents use of existing personal connections of that type. Personal credentials remain private and cannot supply collaborative Session runs.

## Storage and authorization

`packages/backend/src/identity/teams.ts` owns named Team membership and Team policy persistence. Host roles remain in `host_membership`; named memberships live in `host_team_member`. The default Team remains implicit rather than duplicating every Account into that table.

Team edits use one SQLite transaction, including model grants when supplied. Team deletion removes Team grants for models and Sessions, without removing Accounts or their private Sessions. Authorization resolves current membership for model offerings, legacy model grants, and Session shares. Removing a member from a Team removes that source of access on subsequent authorization checks.

Concurrent edits from separate administrators still use last-write-wins semantics. Save coordinates one editor's changes; it is not a cross-client version lock.
