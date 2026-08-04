import { AlertCircle, ArrowLeft, ArrowRight, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { createIdentityClient, IdentityRequestError } from "@/features/identity/identity-client";

export type WorkspaceDialogValues = {
  name: string;
  serverUrl: string;
  authToken: string;
  isLocal: boolean;
};

type AuthMode = "setup" | "login" | "register";

export function WorkspaceDialog({
  open,
  onOpenChange,
  mode,
  initial,
  onSubmit,
  onRemove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "add" | "edit";
  initial: WorkspaceDialogValues;
  onSubmit: (data: { name: string; serverUrl: string; authToken?: string }) => void;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial.name);
  const [serverUrl, setServerUrl] = useState(initial.serverUrl);
  const [authToken, setAuthToken] = useState(initial.authToken);
  const [step, setStep] = useState<"details" | "auth">("details");
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [openRegistration, setOpenRegistration] = useState(false);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(initial.name);
      setServerUrl(initial.serverUrl);
      setAuthToken(initial.authToken);
      setStep("details");
      setAuthMode("login");
      setOpenRegistration(false);
      setUsername("");
      setEmail("");
      setPassword("");
      setConfirmation("");
      setBusy(false);
      setError(null);
    }
  }, [open, initial.name, initial.serverUrl, initial.authToken]);

  const canSubmit = name.trim().length > 0 && (mode === "edit" || serverUrl.trim().length > 0);
  const workspaceData = (token = authToken.trim() || undefined) => ({
    name: name.trim(),
    serverUrl: mode === "edit" ? initial.serverUrl : serverUrl.trim(),
    authToken: token,
  });
  const complete = (token?: string) => {
    onSubmit(workspaceData(token));
    onOpenChange(false);
  };

  async function continueFromDetails() {
    if (!canSubmit || busy) return;
    if (mode === "edit") {
      complete();
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const data = workspaceData();
      const client = createIdentityClient({ baseUrl: data.serverUrl, token: data.authToken });
      const health = await client.health();
      if (!health.authRequired) {
        complete(data.authToken);
        return;
      }
      if (data.authToken) {
        try {
          await client.me();
          complete(data.authToken);
          return;
        } catch (cause) {
          if (!(cause instanceof IdentityRequestError) || ![401, 403].includes(cause.status)) {
            throw cause;
          }
        }
      }
      setAuthMode(health.identity === "setup" ? "setup" : "login");
      if (health.identity === "ready") {
        try {
          const policy = await createIdentityClient({ baseUrl: data.serverUrl }).policy();
          setOpenRegistration(policy.registrationMode === "open");
        } catch {
          setOpenRegistration(false);
        }
      }
      setStep("auth");
    } catch {
      setError(t("identity.connectionError"));
    } finally {
      setBusy(false);
    }
  }

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const needsAccountFields = authMode !== "login";
    if (needsAccountFields && password !== confirmation) {
      setError(t("identity.passwordMismatch"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const client = createIdentityClient({ baseUrl: serverUrl.trim() });
      const session =
        authMode === "setup"
          ? await client.setup({ username: username.trim(), email: email.trim(), password })
          : authMode === "register"
            ? await client.register({ username: username.trim(), email: email.trim(), password })
            : await client.login({ username: username.trim(), password });
      complete(session.token);
    } catch (cause) {
      if (cause instanceof IdentityRequestError && cause.status === 409) {
        setError(t("identity.connectionError"));
      } else {
        setError(t("identity.authenticationError"));
      }
    } finally {
      setBusy(false);
    }
  }

  const needsAccountFields = authMode !== "login";
  const authTitle =
    authMode === "setup"
      ? t("identity.setupTitle")
      : authMode === "register"
        ? t("identity.registerTitle")
        : t("workspace.signInTitle", { name });
  const authAction =
    authMode === "setup"
      ? t("workspace.createOwnerAndAdd")
      : authMode === "register"
        ? t("workspace.createAccountAndAdd")
        : t("workspace.signInAndAdd");

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !busy && onOpenChange(nextOpen)}>
      <DialogContent className="sm:max-w-md">
        {step === "details" ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {mode === "add" ? t("workspace.addTitle") : t("workspace.editTitle")}
              </DialogTitle>
              <DialogDescription>
                {mode === "add" ? t("workspace.addDescription") : t("workspace.editDescription")}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="ws-name">{t("workspace.name")}</Label>
                <Input
                  id="ws-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t("workspace.namePlaceholder")}
                  autoFocus
                  disabled={busy}
                  onKeyDown={(event) => event.key === "Enter" && void continueFromDetails()}
                />
              </div>
              {mode === "add" ? (
                <div className="space-y-2">
                  <Label htmlFor="ws-url">{t("workspace.backendUrl")}</Label>
                  <Input
                    id="ws-url"
                    value={serverUrl}
                    onChange={(event) => setServerUrl(event.target.value)}
                    placeholder={t("workspace.backendUrlPlaceholder")}
                    className="font-mono text-sm"
                    disabled={busy}
                    onKeyDown={(event) => event.key === "Enter" && void continueFromDetails()}
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <Label>{t("workspace.backendUrl")}</Label>
                  <div className="border-input bg-muted/40 text-muted-foreground rounded-md border px-3 py-2 font-mono text-sm">
                    {initial.serverUrl}
                  </div>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="ws-token">
                  {t("workspace.accessToken")}{" "}
                  <span className="text-muted-foreground font-normal">
                    ({t("workspace.optional")})
                  </span>
                </Label>
                <Input
                  id="ws-token"
                  type="password"
                  value={authToken}
                  onChange={(event) => setAuthToken(event.target.value)}
                  placeholder={t("workspace.accessTokenPlaceholder")}
                  disabled={busy}
                  onKeyDown={(event) => event.key === "Enter" && void continueFromDetails()}
                />
              </div>
              {error && (
                <Alert variant="destructive">
                  <AlertCircle />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </div>
            <DialogFooter className="flex-row justify-between sm:justify-between">
              {mode === "edit" && onRemove && !initial.isLocal ? (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    onRemove();
                    onOpenChange(false);
                  }}
                >
                  <Trash2 className="mr-1.5 size-4" />
                  {t("common.remove")}
                </Button>
              ) : (
                <div />
              )}
              <div className="flex gap-2">
                <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
                  {t("common.cancel")}
                </Button>
                <Button disabled={!canSubmit || busy} onClick={() => void continueFromDetails()}>
                  {busy
                    ? t("workspace.checkingHost")
                    : mode === "add"
                      ? t("workspace.continue")
                      : t("common.save")}
                  {mode === "add" && !busy && <ArrowRight className="size-4" />}
                </Button>
              </div>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={(event) => void authenticate(event)}>
            <DialogHeader>
              <button
                type="button"
                className="mb-2 flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setError(null);
                  setStep("details");
                }}
              >
                <ArrowLeft className="size-4" />
                {t("workspace.backToDetails")}
              </button>
              <DialogTitle>{authTitle}</DialogTitle>
              <DialogDescription>
                {t("workspace.authDescription", { host: serverUrl.trim() })}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4 py-5">
              <div className="space-y-2">
                <Label htmlFor="ws-username">{t("identity.username")}</Label>
                <Input
                  id="ws-username"
                  name="username"
                  autoComplete="username"
                  autoFocus
                  required
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </div>
              {needsAccountFields && (
                <div className="space-y-2">
                  <Label htmlFor="ws-email">{t("identity.email")}</Label>
                  <Input
                    id="ws-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="ws-password">{t("identity.password")}</Label>
                <Input
                  id="ws-password"
                  name="password"
                  type="password"
                  autoComplete={needsAccountFields ? "new-password" : "current-password"}
                  minLength={8}
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
              {needsAccountFields && (
                <div className="space-y-2">
                  <Label htmlFor="ws-confirm-password">{t("identity.confirmPassword")}</Label>
                  <Input
                    id="ws-confirm-password"
                    type="password"
                    autoComplete="new-password"
                    minLength={8}
                    required
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                </div>
              )}
              {error && (
                <Alert variant="destructive">
                  <AlertCircle />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              {openRegistration && authMode !== "setup" && (
                <button
                  type="button"
                  className="w-fit text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
                  onClick={() => {
                    setError(null);
                    setAuthMode(authMode === "login" ? "register" : "login");
                  }}
                >
                  {authMode === "login"
                    ? t("identity.switchToRegister")
                    : t("identity.switchToLogin")}
                </button>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? t("identity.signingIn") : authAction}
                {!busy && <ArrowRight className="size-4" />}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
