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

## Mail delivery (optional)

Owners configure SMTP under **Settings → System → Mail delivery**. Mail is off until the owner
enables it with a valid host, sender address, and public HTTPS origin; the SMTP
password is stored Host-side and never displayed again. Members cannot see these
settings. Use **Send test mail** to verify delivery before announcing the feature.

When mail is enabled, any signed-in Account may move its own contact email to a new
address from the profile menu: the current password is rechecked, and the stored
email is replaced only after a single-use confirmation link (30 minutes) is opened
from the new inbox. Confirmation mail follows the reader's language (English,
German, Spanish). Login stays username-based; sessions are not revoked by an
email change. Mail is not a password-recovery mechanism: forgotten member passwords
still use the existing owner-operated reset, regardless of mail settings.

SMTP needs a host, sender address, and public HTTPS origin. Port 465 uses implicit
TLS; any other host outside a loopback relay must negotiate STARTTLS, which the
Host enforces when saving. The SMTP password is kept in Host secret storage and
is never displayed; leave the field untouched to keep it, or use **Remove saved
password** to clear it. Disable mail before changing SMTP providers, then save and
test the complete new configuration before enabling it. Metadata and secret storage
are separate authorities; a failed or interrupted settings save may require resaving
both before using mail.

Known limitation: an authenticated member who guesses another member's address
receives an "unavailable" response when requesting an email change to it. This matches
the pre-existing invite behavior for known addresses and is accepted under the
trusted-team Host model; it is not exposed to unauthenticated callers. Any Host
role (including viewer) may change its own contact email; mail configuration stays
owner-only.

Failed password verifications during email change count toward rate limits (10 per
account per hour, plus a Host-wide verification budget): repeated guessing locks
the request path temporarily without disturbing valid challenges. Public confirmation
attempts share a separate 120/hour Host-wide budget; anonymous traffic can exhaust it
and temporarily delay legitimate email changes. Username/password login is unaffected.
Interrupted deliveries can leave pending reservations until their 30-minute expiry;
a delivered but unusable link may require a fresh request.

## Personal credentials

Restrictions take priority. System, Everyone, or any named Team the Account belongs to can disable personal API keys or subscriptions. A Team cannot override a restriction from another scope. These settings govern supported credential types; they do not add new provider authentication integrations.

The Host checks effective policy when creating personal model connections and when authorizing their use. Disabling a credential type also prevents use of existing personal connections of that type. Personal credentials remain private and cannot supply collaborative Session runs.

## Storage and authorization

`packages/backend/src/identity/teams.ts` owns named Team membership and Team policy persistence. Host roles remain in `host_membership`; named memberships live in `host_team_member`. The default Team remains implicit rather than duplicating every Account into that table.

Team edits use one SQLite transaction, including model grants when supplied. Team deletion removes Team grants for models and Sessions, without removing Accounts or their private Sessions. Authorization resolves current membership for model offerings, legacy model grants, and Session shares. Removing a member from a Team removes that source of access on subsequent authorization checks.

Concurrent edits from separate administrators still use last-write-wins semantics. Save coordinates one editor's changes; it is not a cross-client version lock.
