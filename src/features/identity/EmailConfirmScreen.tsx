import { AlertCircle, CheckCircle2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import openguiLogoDark from "@/../assets/opengui-dark.svg";
import openguiLogoLight from "@/../assets/opengui-light.svg";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { createIdentityClient, IdentityRequestError } from "./identity-client";
import { removeEmailChangeToken } from "./email-confirm-url";
import type { Workspace } from "@/types/workspace";

/**
 * Public email-change confirmation landing. The token arrives through the new
 * inbox, which is the proof, so no session is required (same bar as invite
 * acceptance). The token is stripped from the address bar immediately after
 * reading so it cannot leak through referrers or shoulder-surfing history.
 */
export function EmailConfirmScreen({ token, workspace }: { token: string; workspace: Workspace }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"confirming" | "confirmed" | "failed">("confirming");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  // One shared confirmation attempt per landing. React StrictMode (or any
  // re-mount) reuses the same promise instead of POSTing twice, which would
  // burn the single-use token and show a false failure.
  const attemptRef = useRef<Promise<{ ok: true } | { ok: false; unavailable: boolean }> | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    window.history.replaceState(null, "", removeEmailChangeToken(window.location.href));
    if (!attemptRef.current) {
      attemptRef.current = createIdentityClient({ baseUrl: workspace.serverUrl })
        .confirmEmailChange(token)
        .then(
          () => ({ ok: true as const }),
          (failure: unknown) => ({
            ok: false as const,
            unavailable:
              failure instanceof IdentityRequestError && failure.code === "EMAIL_UNAVAILABLE",
          }),
        );
    }
    void attemptRef.current.then((outcome) => {
      if (cancelled) return;
      if (outcome.ok) {
        setStatus("confirmed");
      } else {
        setStatus("failed");
        setErrorCode(outcome.unavailable ? "unavailable" : "invalid");
      }
    });
    return () => {
      cancelled = true;
    };
    // The token is single-use: confirm exactly once per landing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4 text-foreground">
      <section className="w-full max-w-sm" aria-labelledby="email-confirm-title">
        <div className="mb-8 flex justify-center">
          <img src={openguiLogoDark} alt="OpenGUI" className="hidden h-6 dark:block" />
          <img src={openguiLogoLight} alt="OpenGUI" className="h-6 dark:hidden" />
        </div>
        <header className="mb-6 space-y-2">
          <h1 id="email-confirm-title" className="text-xl font-semibold tracking-tight">
            {t("account.confirmEmailTitle")}
          </h1>
          <p className="text-sm leading-6 text-muted-foreground">
            {t("account.confirmEmailDescription", { host: workspace.name })}
          </p>
        </header>
        {status === "confirming" && (
          <p className="text-sm text-muted-foreground" role="status">
            {t("account.confirmEmailWorking")}
          </p>
        )}
        {status === "confirmed" && (
          <Alert>
            <CheckCircle2 />
            <AlertDescription>{t("account.confirmEmailSuccess")}</AlertDescription>
          </Alert>
        )}
        {status === "failed" && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>
              {t(
                errorCode === "unavailable"
                  ? "account.confirmEmailTaken"
                  : "account.confirmEmailInvalid",
              )}
            </AlertDescription>
          </Alert>
        )}
        {status !== "confirming" && (
          <Button
            type="button"
            size="lg"
            className="mt-6 w-full"
            onClick={() => {
              window.location.hash = "";
              window.location.reload();
            }}
          >
            {t("account.confirmEmailContinue")}
          </Button>
        )}
      </section>
    </main>
  );
}
