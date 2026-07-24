import {
  Check,
  Copy,
  KeyRound,
  Link2,
  RefreshCw,
  Settings2,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { copyTextToClipboard } from "@/lib/browser";
import { notifySuccess } from "@/lib/notify";
import { buildInviteLink } from "./invite-url";
import {
  createIdentityClient,
  type CreatedTeamInvite,
  type CreatedHostApiKey,
  type HostApiKey,
  type HostRegistrationMode,
  type ModelPolicy,
  type PathGrant,
  type PathPolicyStatus,
  type TeamInvite,
  type TeamMember,
} from "./identity-client";
import { PathGrantEditor } from "./PathGrantEditor";
import { pathGrantAdministrationEnabled } from "./path-grants-state";
import { getIdentityWorkspace } from "./workspace-identity";

function SettingsSection({
  icon,
  title,
  description,
  action,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 border-b pb-5 last:border-b-0 last:pb-0">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <span className="mt-0.5 text-muted-foreground" aria-hidden="true">
            {icon}
          </span>
          <div className="space-y-1">
            <h2 className="text-sm font-medium">{title}</h2>
            <p className="max-w-2xl text-xs leading-5 text-muted-foreground">{description}</p>
          </div>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg bg-muted/40 px-3 py-4 text-center text-xs text-muted-foreground">
      {children}
    </p>
  );
}

function formatDate(value: string | number | undefined, locale: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

export function TeamSettings() {
  const { t, i18n } = useTranslation();
  const workspace = useMemo(() => getIdentityWorkspace(), []);
  const client = useMemo(
    () =>
      workspace?.authToken
        ? createIdentityClient({ baseUrl: workspace.serverUrl, token: workspace.authToken })
        : null,
    [workspace],
  );
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [apiKeys, setApiKeys] = useState<HostApiKey[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [pathPolicy, setPathPolicy] = useState<PathPolicyStatus | null>(null);
  const [registrationMode, setRegistrationMode] = useState<HostRegistrationMode>("invite_only");
  const [modelPolicy, setModelPolicy] = useState<ModelPolicy | null>(null);
  const [ownerAccess, setOwnerAccess] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [accessibleRoots, setAccessibleRoots] = useState<string[]>([]);
  const [invitePathGrants, setInvitePathGrants] = useState<PathGrant[]>([]);
  const [keyLabel, setKeyLabel] = useState("");
  const [keyRole, setKeyRole] = useState<"owner" | "member">("member");
  const [busy, setBusy] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<CreatedHostApiKey | null>(null);
  const [createdInvite, setCreatedInvite] = useState<CreatedTeamInvite | null>(null);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [resetMember, setResetMember] = useState<TeamMember | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetConfirmation, setResetConfirmation] = useState("");
  const [resetError, setResetError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    kind: "invite" | "key" | "member";
    id: string;
  } | null>(null);
  const [grantSubject, setGrantSubject] = useState<{
    kind: "member" | "apiKey";
    id: string;
    name: string;
  } | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      const me = await client.me();
      setPathPolicy(me.pathPolicy);
      if (me.actor.type !== "user" || me.actor.role !== "owner") {
        setOwnerAccess(false);
        setMembers([]);
        setInvites([]);
        setApiKeys([]);
        return;
      }
      setOwnerAccess(true);
      const [nextMembers, nextInvites, nextKeys, hostPolicy, nextModelPolicy, roots] =
        await Promise.all([
          client.members(),
          client.invites(),
          client.apiKeys(),
          client.hostPolicy(),
          client.modelPolicy(),
          client.accessibleRoots(),
        ]);
      setCurrentUserId(me.user?.id ?? me.actor.id);
      setMembers(nextMembers);
      setInvites(nextInvites);
      setApiKeys(nextKeys);
      setRegistrationMode(hostPolicy.registrationMode);
      setModelPolicy(nextModelPolicy);
      setAccessibleRoots(roots);
    } catch {
      setError(t("identity.teamLoadError"));
    } finally {
      setLoading(false);
    }
  }, [client, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function copy(value: string) {
    await copyTextToClipboard(value);
    setCopiedValue(value);
    notifySuccess(t("identity.copied"));
    window.setTimeout(
      () => setCopiedValue((current) => (current === value ? null : current)),
      1600,
    );
  }

  async function createInvite(event: FormEvent) {
    event.preventDefault();
    if (!client) return;
    setBusy("create-invite");
    setError(null);
    try {
      const invite = await client.createInvite({
        email: inviteEmail.trim(),
        role: "member",
        pathGrants: invitePathGrants,
      });
      const { token: _token, ...inviteMetadata } = invite;
      setInvites((current) => [inviteMetadata, ...current]);
      setInviteEmail("");
      setInvitePathGrants([]);
      setCreatedInvite(invite);
    } catch {
      setError(t("identity.actionError"));
    } finally {
      setBusy(null);
    }
  }

  async function updateRegistrationMode(mode: HostRegistrationMode) {
    if (!client) return;
    setBusy("registration-mode");
    setError(null);
    try {
      const policy = await client.setHostPolicy({ registrationMode: mode });
      setRegistrationMode(policy.registrationMode);
      notifySuccess(t("identity.registrationModeUpdated"));
    } catch {
      setError(t("identity.actionError"));
    } finally {
      setBusy(null);
    }
  }

  async function updateModelPolicy(
    scope: "host" | "team",
    kind: "allowByok" | "allowByos",
    allowed: boolean,
  ) {
    if (!client || !modelPolicy) return;
    setBusy(`model-policy:${scope}:${kind}`);
    setError(null);
    try {
      const next = await client.setModelPolicy({
        ...modelPolicy,
        [scope]: { ...modelPolicy[scope], [kind]: allowed },
      });
      setModelPolicy(next);
    } catch {
      setError(t("identity.actionError"));
    } finally {
      setBusy(null);
    }
  }

  async function toggleCanInvite(member: TeamMember, canInvite: boolean) {
    if (!client) return;
    setBusy(`can-invite:${member.id}`);
    setError(null);
    try {
      await client.setMemberCanInvite(member.id, canInvite);
      setMembers((items) =>
        items.map((item) => (item.id === member.id ? { ...item, canInvite } : item)),
      );
    } catch {
      setError(t("identity.actionError"));
    } finally {
      setBusy(null);
    }
  }

  async function createKey(event: FormEvent) {
    event.preventDefault();
    if (!client) return;
    setBusy("create-key");
    setError(null);
    try {
      const key = await client.createApiKey({ label: keyLabel.trim(), role: keyRole });
      const { secret: _secret, ...keyMetadata } = key;
      setApiKeys((current) => [keyMetadata, ...current]);
      setKeyLabel("");
      setCreatedKey(key);
    } catch {
      setError(t("identity.actionError"));
    } finally {
      setBusy(null);
    }
  }

  async function revoke(kind: "invite" | "key" | "member", id: string) {
    if (!client) return;
    setBusy(`${kind}:${id}`);
    setError(null);
    try {
      if (kind === "invite") {
        await client.revokeInvite(id);
        setInvites((items) => items.filter((item) => item.id !== id));
      }
      if (kind === "key") {
        await client.revokeApiKey(id);
        setApiKeys((items) => items.filter((item) => item.id !== id));
      }
      if (kind === "member") {
        await client.removeMember(id);
        setMembers((items) => items.filter((item) => item.id !== id));
      }
    } catch {
      setError(t("identity.actionError"));
    } finally {
      setBusy(null);
      setConfirmAction(null);
    }
  }

  async function submitReset(event: FormEvent) {
    event.preventDefault();
    if (!client || !resetMember) return;
    if (resetPassword !== resetConfirmation) {
      setResetError(t("identity.passwordMismatch"));
      return;
    }
    setBusy(`reset:${resetMember.id}`);
    setResetError(null);
    try {
      await client.resetMemberPassword(resetMember.id, resetPassword);
      notifySuccess(t("identity.passwordReset"));
      setResetMember(null);
      setResetPassword("");
      setResetConfirmation("");
    } catch {
      setResetError(t("identity.actionError"));
    } finally {
      setBusy(null);
    }
  }

  if (!client) return <EmptyRow>{t("identity.teamRemoteOnly")}</EmptyRow>;
  if (loading)
    return (
      <div className="space-y-3" role="status" aria-label={t("common.loading")}>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  if (ownerAccess === false) return <EmptyRow>{t("identity.teamOwnerOnly")}</EmptyRow>;

  return (
    <div className="space-y-5">
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <span>{error}</span>
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            <RefreshCw />
            {t("identity.retry")}
          </Button>
        </div>
      )}

      <SettingsSection
        icon={<Settings2 className="size-4" />}
        title={t("identity.hostPolicyTitle")}
        description={t("identity.hostPolicyDescription")}
      >
        <div className="flex flex-col gap-3 rounded-lg border px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <p className="text-sm font-medium">{t("identity.registrationMode")}</p>
            <p className="text-xs text-muted-foreground">
              {t(`identity.registrationModeHelp.${registrationMode}`)}
            </p>
          </div>
          <Select
            value={registrationMode}
            onValueChange={(value) => {
              if (value === "invite_only" || value === "open") void updateRegistrationMode(value);
            }}
            disabled={busy === "registration-mode"}
          >
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="invite_only">
                {t("identity.registrationModes.invite_only")}
              </SelectItem>
              <SelectItem value="open">{t("identity.registrationModes.open")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {modelPolicy && (
          <div className="divide-y rounded-lg border">
            {(["host", "team"] as const).flatMap((scope) =>
              (["allowByok", "allowByos"] as const).map((kind) => (
                <label
                  key={`${scope}:${kind}`}
                  className="flex items-center justify-between gap-4 px-3 py-3"
                >
                  <span>
                    <span className="block text-sm font-medium">
                      {t(`identity.modelPolicy.${scope}.${kind}`)}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t(`identity.modelPolicy.${kind}Help`)}
                    </span>
                  </span>
                  <Switch
                    checked={modelPolicy[scope][kind]}
                    disabled={busy === `model-policy:${scope}:${kind}`}
                    onCheckedChange={(checked) => void updateModelPolicy(scope, kind, checked)}
                  />
                </label>
              )),
            )}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        icon={<Users className="size-4" />}
        title={t("identity.membersTitle")}
        description={t("identity.membersDescription")}
      >
        <div className="divide-y rounded-lg border">
          {members.length === 0 ? (
            <EmptyRow>{t("identity.noMembers")}</EmptyRow>
          ) : (
            members.map((member) => (
              <div key={member.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{member.username}</span>
                    <Badge variant="outline">{t(`identity.roles.${member.role}`)}</Badge>
                    {member.id === currentUserId && (
                      <span className="text-xs text-muted-foreground">{t("identity.you")}</span>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {member.role !== "owner" && (
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Switch
                        checked={!!member.canInvite}
                        disabled={busy === `can-invite:${member.id}`}
                        onCheckedChange={(checked) => void toggleCanInvite(member, checked)}
                        aria-label={t("identity.canInviteLabel", { name: member.username })}
                      />
                      {t("identity.canInvite")}
                    </label>
                  )}
                  {pathGrantAdministrationEnabled(pathPolicy) &&
                    (member.role === "owner" ? (
                      <span className="px-2 text-xs text-muted-foreground">
                        {t("identity.pathGrants.unrestricted")}
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setGrantSubject({ kind: "member", id: member.id, name: member.username })
                        }
                      >
                        {t("identity.pathGrants.access")}
                      </Button>
                    ))}
                  {member.role !== "owner" && member.id !== currentUserId && (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => setResetMember(member)}>
                        {t("identity.resetPassword")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("identity.removeMember", { name: member.username })}
                        disabled={busy === `member:${member.id}`}
                        onClick={() => setConfirmAction({ kind: "member", id: member.id })}
                      >
                        <Trash2 />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        icon={<UserPlus className="size-4" />}
        title={t("identity.invitesTitle")}
        description={t("identity.invitesDescription")}
      >
        <form className="space-y-3" onSubmit={(event) => void createInvite(event)}>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Label htmlFor="team-invite-email" className="sr-only">
              {t("identity.inviteEmail")}
            </Label>
            <Input
              id="team-invite-email"
              type="email"
              autoComplete="email"
              required
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder={t("identity.inviteEmail")}
            />
            <Button type="submit" disabled={busy === "create-invite"}>
              <Link2 />
              {t("identity.createInvite")}
            </Button>
          </div>
          {accessibleRoots.length > 0 && (
            <fieldset className="space-y-2 rounded-lg border p-3">
              <legend className="px-1 text-xs font-medium">{t("identity.invitePaths")}</legend>
              <p className="text-xs text-muted-foreground">{t("identity.invitePathsHelp")}</p>
              {accessibleRoots.map((root) => {
                const grant = invitePathGrants.find((item) => item.root === root);
                return (
                  <div key={root} className="flex flex-wrap items-center gap-2 py-1">
                    <Checkbox
                      id={`invite-root-${root}`}
                      checked={!!grant}
                      onCheckedChange={(checked) =>
                        setInvitePathGrants((current) =>
                          checked
                            ? [...current, { root, access: "read" }]
                            : current.filter((item) => item.root !== root),
                        )
                      }
                    />
                    <Label
                      htmlFor={`invite-root-${root}`}
                      className="min-w-0 flex-1 truncate font-mono text-xs"
                    >
                      {root}
                    </Label>
                    {grant && (
                      <Select
                        value={grant.access}
                        onValueChange={(access) =>
                          setInvitePathGrants((current) =>
                            current.map((item) =>
                              item.root === root
                                ? { ...item, access: access as "read" | "write" }
                                : item,
                            ),
                          )
                        }
                      >
                        <SelectTrigger className="h-8 w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="read">{t("identity.pathGrants.readOnly")}</SelectItem>
                          <SelectItem value="write">
                            {t("identity.pathGrants.readWrite")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                );
              })}
            </fieldset>
          )}
        </form>
        {invites.length === 0 ? (
          <EmptyRow>{t("identity.noInvites")}</EmptyRow>
        ) : (
          <div className="divide-y rounded-lg border">
            {invites.map((invite) => {
              const expires = formatDate(invite.expiresAt, i18n.language);
              return (
                <div
                  key={invite.id}
                  className="flex items-center justify-between gap-3 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm">{invite.email}</p>
                    <p className="text-xs text-muted-foreground">
                      {expires ? t("identity.expires", { date: expires }) : t("identity.pending")}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("identity.revokeInvite", { email: invite.email })}
                      disabled={busy === `invite:${invite.id}`}
                      onClick={() => setConfirmAction({ kind: "invite", id: invite.id })}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        icon={<KeyRound className="size-4" />}
        title={t("identity.apiKeysTitle")}
        description={t("identity.apiKeysDescription")}
      >
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => void createKey(event)}
        >
          <Label htmlFor="api-key-label" className="sr-only">
            {t("identity.keyLabel")}
          </Label>
          <Input
            id="api-key-label"
            required
            value={keyLabel}
            onChange={(event) => setKeyLabel(event.target.value)}
            placeholder={t("identity.keyLabel")}
          />
          <Select
            value={keyRole}
            onValueChange={(value) => setKeyRole(value as "owner" | "member")}
          >
            <SelectTrigger className="sm:w-36" aria-label={t("identity.keyRole")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">{t("identity.roles.member")}</SelectItem>
              <SelectItem value="owner">{t("identity.roles.owner")}</SelectItem>
            </SelectContent>
          </Select>
          <Button type="submit" disabled={busy === "create-key"}>
            <KeyRound />
            {t("identity.createKey")}
          </Button>
        </form>
        {apiKeys.length === 0 ? (
          <EmptyRow>{t("identity.noApiKeys")}</EmptyRow>
        ) : (
          <div className="divide-y rounded-lg border">
            {apiKeys.map((key) => (
              <div key={key.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{key.label}</span>
                    <Badge variant="outline">{t(`identity.roles.${key.role}`)}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(key.createdAt, i18n.language)
                      ? t("identity.created", { date: formatDate(key.createdAt, i18n.language) })
                      : t("identity.neverUsed")}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {pathGrantAdministrationEnabled(pathPolicy) &&
                    (key.role === "owner" ? (
                      <span className="px-2 text-xs text-muted-foreground">
                        {t("identity.pathGrants.unrestricted")}
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setGrantSubject({ kind: "apiKey", id: key.id, name: key.label })
                        }
                      >
                        {t("identity.pathGrants.access")}
                      </Button>
                    ))}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("identity.revokeKey", { label: key.label })}
                    disabled={busy === `key:${key.id}`}
                    onClick={() => setConfirmAction({ kind: "key", id: key.id })}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      {grantSubject && (
        <PathGrantEditor
          subject={grantSubject}
          onClose={() => setGrantSubject(null)}
          load={async () => {
            if (!client) return [];
            const result =
              grantSubject.kind === "member"
                ? await client.memberPathGrants(grantSubject.id)
                : await client.apiKeyPathGrants(grantSubject.id);
            return result.grants;
          }}
          save={async (grants: PathGrant[]) => {
            if (!client) return grants;
            const result =
              grantSubject.kind === "member"
                ? await client.replaceMemberPathGrants(grantSubject.id, grants)
                : await client.replaceApiKeyPathGrants(grantSubject.id, grants);
            return result.grants;
          }}
        />
      )}

      <Dialog
        open={!!createdInvite}
        onOpenChange={(open) => {
          if (!open) setCreatedInvite(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("identity.inviteCreatedTitle")}</DialogTitle>
            <DialogDescription>{t("identity.inviteCreatedDescription")}</DialogDescription>
          </DialogHeader>
          {createdInvite &&
            (() => {
              const link = buildInviteLink(window.location.href, createdInvite.token);
              return (
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    className="font-mono"
                    value={link}
                    aria-label={t("identity.inviteLink")}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={t("identity.copyLink")}
                    onClick={() => void copy(link)}
                  >
                    {copiedValue === link ? <Check /> : <Copy />}
                  </Button>
                </div>
              );
            })()}
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!createdKey}
        onOpenChange={(open) => {
          if (!open) setCreatedKey(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("identity.keyCreatedTitle")}</DialogTitle>
            <DialogDescription>{t("identity.keyCreatedDescription")}</DialogDescription>
          </DialogHeader>
          {createdKey && (
            <div className="flex items-center gap-2">
              <Input
                readOnly
                className="font-mono"
                value={createdKey.secret}
                aria-label={t("identity.apiKeySecret")}
              />
              <Button
                variant="outline"
                size="icon"
                aria-label={t("identity.copySecret")}
                onClick={() => void copy(createdKey.secret)}
              >
                {copiedValue === createdKey.secret ? <Check /> : <Copy />}
              </Button>
            </div>
          )}
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmAction} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("identity.confirmActionTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction
                ? t(
                    `identity.${confirmAction.kind === "member" ? "removeMemberConfirm" : confirmAction.kind === "invite" ? "revokeInviteConfirm" : "revokeKeyConfirm"}`,
                  )
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!!confirmAction && busy === `${confirmAction.kind}:${confirmAction.id}`}
              onClick={() => {
                if (confirmAction) void revoke(confirmAction.kind, confirmAction.id);
              }}
            >
              {confirmAction?.kind === "member" ? t("common.remove") : t("identity.revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={!!resetMember}
        onOpenChange={(open) => {
          if (!open) {
            setResetMember(null);
            setResetPassword("");
            setResetConfirmation("");
            setResetError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("identity.resetPasswordTitle", { name: resetMember?.username })}
            </DialogTitle>
            <DialogDescription>{t("identity.resetPasswordDescription")}</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={(event) => void submitReset(event)}>
            <div className="space-y-2">
              <Label htmlFor="member-new-password">{t("identity.password")}</Label>
              <Input
                id="member-new-password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                value={resetPassword}
                onChange={(event) => setResetPassword(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="member-confirm-password">{t("identity.confirmPassword")}</Label>
              <Input
                id="member-confirm-password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                aria-invalid={!!resetError}
                value={resetConfirmation}
                onChange={(event) => setResetConfirmation(event.target.value)}
              />
            </div>
            {resetError && (
              <p role="alert" className="text-sm text-destructive">
                {resetError}
              </p>
            )}
            <DialogFooter>
              <Button type="submit" disabled={busy?.startsWith("reset:")}>
                {t("identity.resetPassword")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
