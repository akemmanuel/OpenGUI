import { AlertCircle, ArrowRight, RefreshCw } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useReducer, useState } from "react";
import { useTranslation } from "react-i18next";
import openguiLogoDark from "@/../assets/opengui-dark.svg";
import openguiLogoLight from "@/../assets/opengui-light.svg";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { getShellWorkspacePolicy } from "@/runtime/shell-policy";
import { createIdentityClient, IdentityRequestError } from "./identity-client";
import type { IdentityActor } from "./identity-client";
import { DESKTOP_LOCAL_ACTOR, IdentityActorProvider } from "./identity-actor-context";
import { identityGateReducer, shouldBypassIdentity } from "./identity-state";
import { InviteAcceptScreen } from "./InviteAcceptScreen";
import { readViewLinkToken, ViewLinkScreen } from "./ViewLinkScreen";
import { readInviteToken } from "./invite-url";
import {
  getIdentityWorkspace,
  persistWorkspaceIdentityToken,
  WORKSPACE_IDENTITY_CHANGE_EVENT,
} from "./workspace-identity";

function IdentityShell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4 text-foreground">
      <section className="w-full max-w-sm" aria-live="polite">
        <div className="mb-8 flex justify-center">
          <img src={openguiLogoDark} alt="OpenGUI" className="hidden h-6 dark:block" />
          <img src={openguiLogoLight} alt="OpenGUI" className="h-6 dark:hidden" />
        </div>
        {children}
      </section>
    </main>
  );
}

function IdentityLoading() {
  const { t } = useTranslation();
  return (
    <IdentityShell>
      <div role="status" aria-label={t("identity.checkingHost")} className="space-y-5">
        <div className="space-y-2">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-4 w-full" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      </div>
    </IdentityShell>
  );
}

function IdentityForm({
  mode,
  hostName,
  error,
  submitting,
  openRegistration,
  onModeChange,
  onSubmit,
}: {
  mode: "setup" | "login" | "register";
  hostName: string;
  error: string | null;
  submitting: boolean;
  openRegistration?: boolean;
  onModeChange?: (mode: "login" | "register") => void;
  onSubmit: (input: { username: string; email?: string; password: string }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const needsAccountFields = mode === "setup" || mode === "register";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (needsAccountFields && password !== confirmation) {
      setValidationError(t("identity.passwordMismatch"));
      return;
    }
    setValidationError(null);
    await onSubmit({ username: username.trim(), email: email.trim() || undefined, password });
  }

  const titleKey =
    mode === "setup"
      ? "identity.setupTitle"
      : mode === "register"
        ? "identity.registerTitle"
        : "identity.loginTitle";
  const descriptionKey =
    mode === "setup"
      ? "identity.setupDescription"
      : mode === "register"
        ? "identity.registerDescription"
        : "identity.loginDescription";
  const submitBusyKey =
    mode === "setup"
      ? "identity.creatingOwner"
      : mode === "register"
        ? "identity.creatingAccount"
        : "identity.signingIn";
  const submitKey =
    mode === "setup"
      ? "identity.createOwner"
      : mode === "register"
        ? "identity.createAccount"
        : "identity.signIn";

  const visibleError = validationError ?? error;
  return (
    <IdentityShell>
      <header className="mb-6 space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">{t(titleKey)}</h1>
        <p className="text-sm leading-6 text-muted-foreground">
          {t(descriptionKey, { host: hostName })}
        </p>
      </header>

      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <div className="space-y-2">
          <Label htmlFor="identity-username">{t("identity.username")}</Label>
          <Input
            id="identity-username"
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
            <Label htmlFor="identity-email">{t("identity.email")}</Label>
            <Input
              id="identity-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="identity-password">{t("identity.password")}</Label>
          <Input
            id="identity-password"
            name="password"
            type="password"
            autoComplete={needsAccountFields ? "new-password" : "current-password"}
            minLength={8}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {needsAccountFields && (
            <p className="text-xs leading-5 text-muted-foreground">{t("identity.passwordHint")}</p>
          )}
        </div>
        {needsAccountFields && (
          <div className="space-y-2">
            <Label htmlFor="identity-confirm-password">{t("identity.confirmPassword")}</Label>
            <Input
              id="identity-confirm-password"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              aria-invalid={!!validationError}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </div>
        )}
        {visibleError && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{visibleError}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" size="lg" className="w-full" disabled={submitting}>
          {submitting ? t(submitBusyKey) : t(submitKey)}
          {!submitting && <ArrowRight className="size-4" />}
        </Button>
      </form>
      {openRegistration && mode !== "setup" && onModeChange && (
        <p className="mt-4 text-center text-sm text-muted-foreground">
          {mode === "login" ? (
            <button
              type="button"
              className="underline underline-offset-4 hover:text-foreground"
              onClick={() => onModeChange("register")}
            >
              {t("identity.switchToRegister")}
            </button>
          ) : (
            <button
              type="button"
              className="underline underline-offset-4 hover:text-foreground"
              onClick={() => onModeChange("login")}
            >
              {t("identity.switchToLogin")}
            </button>
          )}
        </p>
      )}
      <p className="mt-5 text-center text-xs text-muted-foreground">
        {t("identity.hostLabel", { host: hostName })}
      </p>
    </IdentityShell>
  );
}

function IdentityGateContent({
  children,
  onActorChange,
}: {
  children: ReactNode;
  onActorChange: (actor: IdentityActor | null) => void;
}) {
  const { t } = useTranslation();
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const workspace = useMemo(() => getIdentityWorkspace(), [workspaceRevision]);
  const policy = useMemo(() => getShellWorkspacePolicy(), []);
  const localBypass = !!workspace && shouldBypassIdentity(policy.shellKind, workspace.isLocal);
  const bypass = !workspace || localBypass;
  const [state, dispatch] = useReducer(identityGateReducer, { status: "checking" });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [authorizedWorkspaceId, setAuthorizedWorkspaceId] = useState<string | null>(null);
  const [openRegistration, setOpenRegistration] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const inviteToken = typeof window === "undefined" ? null : readInviteToken(window.location.href);

  useEffect(() => {
    const handleWorkspaceChange = () => setWorkspaceRevision((current) => current + 1);
    window.addEventListener(WORKSPACE_IDENTITY_CHANGE_EVENT, handleWorkspaceChange);
    return () => window.removeEventListener(WORKSPACE_IDENTITY_CHANGE_EVENT, handleWorkspaceChange);
  }, []);

  useEffect(() => {
    onActorChange(localBypass ? DESKTOP_LOCAL_ACTOR : null);
  }, [localBypass, onActorChange, workspace?.id]);

  useEffect(() => {
    if (bypass || !workspace) return;
    let cancelled = false;
    setAuthorizedWorkspaceId(null);
    dispatch({ type: "check" });
    setSubmitError(null);
    const client = createIdentityClient({
      baseUrl: workspace.serverUrl,
      token: workspace.authToken,
    });
    void (async () => {
      try {
        const health = await client.health();
        if (cancelled) return;
        if (health.identity === "ready") {
          try {
            const policy = await client.policy();
            if (!cancelled) setOpenRegistration(policy.registrationMode === "open");
          } catch {
            if (!cancelled) setOpenRegistration(false);
          }
        } else if (!cancelled) {
          setOpenRegistration(false);
        }
        if (!cancelled) setAuthMode("login");
        dispatch({ type: "health", health, hasToken: !!workspace.authToken });
        if (!health.authRequired) setAuthorizedWorkspaceId(workspace.id);
        if (health.authRequired && health.identity === "ready" && workspace.authToken) {
          try {
            const identity = await client.me();
            if (!cancelled) {
              onActorChange(identity.actor);
              setAuthorizedWorkspaceId(workspace.id);
              dispatch({ type: "authenticated", health });
            }
          } catch (error) {
            if (cancelled) return;
            if (error instanceof IdentityRequestError && [401, 403].includes(error.status)) {
              persistWorkspaceIdentityToken(workspace.id, undefined);
              dispatch({ type: "invalid-session", health });
            } else {
              throw error;
            }
          }
        }
      } catch {
        if (!cancelled) {
          dispatch({
            type: "failed",
            message: t("identity.connectionError"),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bypass, onActorChange, retryKey, t, workspace]);

  if (inviteToken && workspace && !bypass) {
    return <InviteAcceptScreen token={inviteToken} workspace={workspace} />;
  }
  if (bypass) return children;
  if (!workspace || state.status === "checking") return <IdentityLoading />;
  if (state.status === "error") {
    return (
      <IdentityShell>
        <div className="space-y-5 text-center">
          <div className="space-y-2">
            <h1 className="text-xl font-semibold tracking-tight">
              {t("identity.unavailableTitle")}
            </h1>
            <p className="text-sm leading-6 text-muted-foreground">
              {t("identity.unavailableDescription", { host: workspace.name })}
            </p>
          </div>
          <Alert variant="destructive" className="text-left">
            <AlertCircle />
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={() => setRetryKey((current) => current + 1)}>
            <RefreshCw className="size-4" />
            {t("identity.retry")}
          </Button>
        </div>
      </IdentityShell>
    );
  }
  if (state.status === "authenticated") {
    return authorizedWorkspaceId === workspace.id ? children : <IdentityLoading />;
  }

  const mode = state.status === "login" ? authMode : state.status;
  return (
    <IdentityForm
      key={`${workspace.id}:${mode}`}
      mode={mode}
      hostName={workspace.name}
      error={submitError}
      submitting={submitting}
      openRegistration={openRegistration}
      onModeChange={setAuthMode}
      onSubmit={async (input) => {
        setSubmitting(true);
        setSubmitError(null);
        try {
          const client = createIdentityClient({ baseUrl: workspace.serverUrl });
          const session =
            mode === "setup"
              ? await client.setup({
                  username: input.username,
                  email: input.email ?? "",
                  password: input.password,
                })
              : mode === "register"
                ? await client.register({
                    username: input.username,
                    email: input.email ?? "",
                    password: input.password,
                  })
                : await client.login({ username: input.username, password: input.password });
          persistWorkspaceIdentityToken(workspace.id, session.token);
          onActorChange(session.actor);
          setAuthorizedWorkspaceId(workspace.id);
          dispatch({ type: "authenticated", health: state.health });
        } catch (error) {
          if (error instanceof IdentityRequestError && error.status === 409) {
            setRetryKey((current) => current + 1);
          } else {
            setSubmitError(t("identity.authenticationError"));
          }
        } finally {
          setSubmitting(false);
        }
      }}
    />
  );
}

export function IdentityGate({ children }: { children: ReactNode }) {
  const viewToken = typeof window === "undefined" ? null : readViewLinkToken();
  const [actor, setActor] = useState<IdentityActor | null>(() => {
    const workspace = getIdentityWorkspace();
    const policy = getShellWorkspacePolicy();
    return workspace && shouldBypassIdentity(policy.shellKind, workspace.isLocal)
      ? DESKTOP_LOCAL_ACTOR
      : null;
  });

  if (viewToken) return <ViewLinkScreen token={viewToken} />;

  return (
    <IdentityActorProvider actor={actor}>
      <IdentityGateContent onActorChange={setActor}>{children}</IdentityGateContent>
    </IdentityActorProvider>
  );
}
