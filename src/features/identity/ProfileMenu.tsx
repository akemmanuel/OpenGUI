import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff, KeyRound, LogOut, Mail, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useWorkspaceState } from "@/hooks/use-agent-state";
import { toast } from "sonner";
import { useIdentityActor } from "./identity-actor-context";
import { createIdentityClient, IdentityRequestError, type IdentityUser } from "./identity-client";
import {
  announceIdentityWorkspaceChange,
  logoutActiveWorkspaceIdentity,
  persistWorkspaceIdentityToken,
} from "./workspace-identity";

export function ProfileMenu() {
  const actor = useIdentityActor();
  const { activeWorkspace } = useWorkspaceState();
  if (actor?.type !== "user" || !activeWorkspace?.authToken) return null;
  return (
    <AccountMenu
      key={`${activeWorkspace.id}:${activeWorkspace.authToken}`}
      host={activeWorkspace.name}
      baseUrl={activeWorkspace.serverUrl}
      token={activeWorkspace.authToken}
      workspaceId={activeWorkspace.id}
      actorName={actor.displayName}
    />
  );
}

function AccountMenu({
  host,
  baseUrl,
  token,
  workspaceId,
  actorName,
}: {
  host: string;
  baseUrl: string;
  token: string;
  workspaceId: string;
  actorName: string;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => createIdentityClient({ baseUrl, token }), [baseUrl, token]);
  const [user, setUser] = useState<IdentityUser | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [dialog, setDialog] = useState<"profile" | "password" | "email" | null>(null);
  const [lastDialog, setLastDialog] = useState<"profile" | "password" | "email">("profile");
  const visibleDialog = dialog ?? lastDialog;
  const [displayName, setDisplayName] = useState(actorName);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [pendingEmail, setPendingEmail] = useState<{ email: string; expiresAt: number } | null>(
    null,
  );
  const [showPasswords, setShowPasswords] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
    void client
      .me()
      .then((me) => {
        if (!cancelled) {
          setUser(me.user);
          setDisplayName(me.user?.name || me.actor.displayName);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, retry]);

  function open(kind: "profile" | "password" | "email") {
    setError(null);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmation("");
    setShowPasswords(false);
    setDisplayName(user?.name || actorName);
    setLastDialog(kind);
    setDialog(kind);
    if (kind === "email") {
      setEmailPassword("");
      void client
        .me()
        .then((me) => {
          setUser(me.user);
        })
        .catch(() => {});
      void client
        .emailChangeStatus()
        .then((status) => setPendingEmail(status.pending))
        .catch(() => setPendingEmail(null));
    }
  }
  function emailErrorMessage(failure: unknown) {
    if (!(failure instanceof IdentityRequestError)) return t("account.saveFailed");
    switch (failure.code) {
      case "INVALID_PASSWORD":
        return t("account.wrongPassword");
      case "MAIL_NOT_CONFIGURED":
        return t("account.emailMailNotConfigured");
      case "MAIL_SEND_FAILED":
        return t("account.emailSendFailed");
      case "EMAIL_UNAVAILABLE":
        return t("account.emailUnavailable");
      case "INVALID_EMAIL":
        return t("account.emailInvalid");
      case "RATE_LIMITED":
        return t("account.emailRateLimited");
      case "EMAIL_CHANGE_SUPERSEDED":
        return t("account.emailSuperseded");
      default:
        return t("account.saveFailed");
    }
  }
  function browserLanguage(): string | undefined {
    return typeof navigator === "undefined" || !navigator.language
      ? undefined
      : navigator.language.slice(0, 35);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (dialog === "password" && newPassword !== confirmation) {
      setError(t("identity.passwordMismatch"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (dialog === "profile") {
        await client.updateProfile(displayName.trim());
        setUser((previous) => (previous ? { ...previous, name: displayName.trim() } : previous));
        toast.success(t("account.profileSaved"));
        setDialog(null);
        announceIdentityWorkspaceChange();
      } else if (dialog === "email") {
        const result = await client.requestEmailChange(
          {
            newEmail: newEmail.trim(),
            currentPassword: emailPassword,
          },
          browserLanguage(),
        );
        toast.success(t("account.emailChangeRequested"));
        setEmailPassword("");
        // The draft address is preserved as the visible pending change.
        setPendingEmail({ email: newEmail.trim(), expiresAt: result.expiresAt });
      } else {
        const result = await client.changePassword({ currentPassword, newPassword });
        toast.success(t("account.passwordSaved"));
        setDialog(null);
        setCurrentPassword("");
        setNewPassword("");
        setConfirmation("");
        persistWorkspaceIdentityToken(workspaceId, result.token);
      }
    } catch (failure) {
      setError(
        dialog === "email"
          ? emailErrorMessage(failure)
          : t(
              failure instanceof IdentityRequestError && failure.code === "INVALID_PASSWORD"
                ? "account.wrongPassword"
                : "account.saveFailed",
            ),
      );
    } finally {
      setBusy(false);
    }
  }
  async function cancelPendingEmail() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.cancelEmailChange();
      setPendingEmail(null);
      toast.success(t("account.emailChangeCancelled"));
    } catch {
      setError(t("account.saveFailed"));
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    try {
      await logoutActiveWorkspaceIdentity();
    } catch {
      toast.error(t("account.logoutFailed"));
    } finally {
      setBusy(false);
    }
  }
  const name = user?.name || actorName;
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toLocaleUpperCase();
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" />}
          disabled={busy}
          aria-label={t("account.openProfile")}
          title={name}
          className="h-auto w-full justify-start gap-2 px-3 py-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          <span
            aria-hidden="true"
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium"
          >
            {initials}
          </span>
          <span className="truncate text-sm group-data-[collapsible=icon]:hidden">{name}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-64 max-w-[calc(100vw-2rem)]">
          <div className="space-y-1 px-2 py-2 text-sm">
            <p className="break-words font-medium">{name}</p>
            {user && <p className="break-all text-xs text-muted-foreground">{user.email}</p>}
            <p className="break-words text-xs text-muted-foreground">
              {t("account.connectedHost", { host })}
            </p>
            {loadError && (
              <Button variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>
                {t("account.retryProfile")}
              </Button>
            )}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!user} onClick={() => open("profile")}>
            <UserRound />
            {t("account.editProfile")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!user} onClick={() => open("password")}>
            <KeyRound />
            {t("account.changePassword")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!user} onClick={() => open("email")}>
            <Mail />
            {t("account.changeEmail")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => void logout()}>
            <LogOut />
            {t("identity.signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={dialog !== null}
        onOpenChange={(value) => {
          if (!value && !busy) {
            setDialog(null);
            setCurrentPassword("");
            setNewPassword("");
            setConfirmation("");
            setEmailPassword("");
          }
        }}
      >
        <DialogContent showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>
              {t(
                visibleDialog === "password"
                  ? "account.changePassword"
                  : visibleDialog === "email"
                    ? "account.changeEmail"
                    : "account.editProfile",
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                visibleDialog === "password"
                  ? "account.passwordDescription"
                  : visibleDialog === "email"
                    ? "account.emailDescription"
                    : "account.profileDescription",
              )}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void submit(event)} className="space-y-4">
            <fieldset disabled={busy} className="space-y-4">
              {visibleDialog === "email" ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="account-current-email">{t("account.currentEmail")}</Label>
                    <Input
                      id="account-current-email"
                      type="email"
                      autoComplete="email"
                      readOnly
                      value={user?.email || ""}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="account-new-email">{t("account.newEmail")}</Label>
                    <Input
                      id="account-new-email"
                      type="email"
                      autoComplete="email"
                      required
                      maxLength={254}
                      value={newEmail}
                      onChange={(event) => setNewEmail(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="account-email-password">{t("account.currentPassword")}</Label>
                    <Input
                      id="account-email-password"
                      type={showPasswords ? "text" : "password"}
                      autoComplete="current-password"
                      required
                      value={emailPassword}
                      onChange={(event) => setEmailPassword(event.target.value)}
                    />
                  </div>
                  {pendingEmail && (
                    <div className="space-y-2 rounded-md border border-dashed p-3 text-sm">
                      <p className="text-muted-foreground">
                        {t("account.emailPendingNotice", { email: pendingEmail.email })}
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void cancelPendingEmail()}
                      >
                        {t("account.emailCancelChange")}
                      </Button>
                    </div>
                  )}
                </>
              ) : visibleDialog === "profile" ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="account-name">{t("account.displayName")}</Label>
                    <Input
                      id="account-name"
                      autoComplete="name"
                      required
                      maxLength={100}
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="account-username">{t("identity.username")}</Label>
                    <Input
                      id="account-username"
                      autoComplete="username"
                      readOnly
                      value={user?.username || ""}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="account-email">{t("identity.email")}</Label>
                    <Input
                      id="account-email"
                      type="email"
                      autoComplete="email"
                      readOnly
                      value={user?.email || ""}
                    />
                  </div>
                </>
              ) : (
                <>
                  <input
                    type="text"
                    name="username"
                    autoComplete="username"
                    value={user?.username || ""}
                    readOnly
                    hidden
                  />
                  {(
                    [
                      {
                        id: "current",
                        label: "account.currentPassword",
                        value: currentPassword,
                        set: setCurrentPassword,
                        autoComplete: "current-password",
                      },
                      {
                        id: "new",
                        label: "account.newPassword",
                        value: newPassword,
                        set: setNewPassword,
                        autoComplete: "new-password",
                      },
                      {
                        id: "confirm",
                        label: "identity.confirmPassword",
                        value: confirmation,
                        set: setConfirmation,
                        autoComplete: "new-password",
                      },
                    ] as const
                  ).map((field) => (
                    <div key={field.id} className="space-y-2">
                      <Label htmlFor={`account-${field.id}`}>{t(field.label)}</Label>
                      <Input
                        id={`account-${field.id}`}
                        name={field.id}
                        type={showPasswords ? "text" : "password"}
                        autoComplete={field.autoComplete}
                        required
                        minLength={field.id === "current" ? undefined : 8}
                        maxLength={128}
                        value={field.value}
                        onChange={(event) => field.set(event.target.value)}
                      />
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-pressed={showPasswords}
                    onClick={() => setShowPasswords(!showPasswords)}
                  >
                    {showPasswords ? <EyeOff /> : <Eye />}
                    {t(showPasswords ? "account.hidePasswords" : "account.showPasswords")}
                  </Button>
                  <p className="text-xs text-muted-foreground">{t("identity.passwordHint")}</p>
                </>
              )}
            </fieldset>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setDialog(null);
                  setCurrentPassword("");
                  setNewPassword("");
                  setConfirmation("");
                  setEmailPassword("");
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={busy || (dialog === "profile" && !displayName.trim())}
              >
                {t(busy ? "account.saving" : "common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
