import { AlertCircle, ArrowRight } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import openguiLogoDark from "@/../assets/opengui-dark.svg";
import openguiLogoLight from "@/../assets/opengui-light.svg";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createIdentityClient } from "./identity-client";
import { removeInviteToken } from "./invite-url";
import { persistWorkspaceIdentityToken } from "./workspace-identity";
import type { Workspace } from "@/types/workspace";

export function InviteAcceptScreen({ token, workspace }: { token: string; workspace: Workspace }) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmation) {
      setError(t("identity.passwordMismatch"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const session = await createIdentityClient({ baseUrl: workspace.serverUrl }).acceptInvite({
        token,
        username: username.trim(),
        email: email.trim(),
        password,
      });
      setPassword("");
      setConfirmation("");
      window.history.replaceState(null, "", removeInviteToken(window.location.href));
      persistWorkspaceIdentityToken(workspace.id, session.token);
    } catch {
      setError(t("identity.inviteAcceptError"));
      setPassword("");
      setConfirmation("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4 text-foreground">
      <section className="w-full max-w-sm" aria-labelledby="invite-accept-title">
        <div className="mb-8 flex justify-center">
          <img src={openguiLogoDark} alt="OpenGUI" className="hidden h-6 dark:block" />
          <img src={openguiLogoLight} alt="OpenGUI" className="h-6 dark:hidden" />
        </div>
        <header className="mb-6 space-y-2">
          <h1 id="invite-accept-title" className="text-xl font-semibold tracking-tight">
            {t("identity.acceptInviteTitle")}
          </h1>
          <p className="text-sm leading-6 text-muted-foreground">
            {t("identity.acceptInviteDescription", { host: workspace.name })}
          </p>
        </header>
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <div className="space-y-2">
            <Label htmlFor="invite-username">{t("identity.username")}</Label>
            <Input
              id="invite-username"
              autoComplete="username"
              autoFocus
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="invite-email">{t("identity.email")}</Label>
            <Input
              id="invite-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="invite-password">{t("identity.password")}</Label>
            <Input
              id="invite-password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <p className="text-xs leading-5 text-muted-foreground">{t("identity.passwordHint")}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="invite-confirm-password">{t("identity.confirmPassword")}</Label>
            <Input
              id="invite-confirm-password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              aria-invalid={!!error}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" size="lg" className="w-full" disabled={submitting}>
            {t(submitting ? "identity.joiningTeam" : "identity.joinTeam")}
            {!submitting && <ArrowRight className="size-4" />}
          </Button>
        </form>
      </section>
    </main>
  );
}
