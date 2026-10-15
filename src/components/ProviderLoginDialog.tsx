import { Check, Copy, ExternalLink, Loader2, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { copyTextToClipboard, openExternalLink } from "@/lib/browser";
import type { ProviderLoginEvent, ProviderLoginStatus } from "@/protocol/host-types";

const DEFAULT_POLL_MS = 1_500;
const SUCCESS_CLOSE_MS = 1_200;

function safeUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function urlHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function latest<T extends ProviderLoginEvent["type"]>(
  events: ProviderLoginEvent[],
  type: T,
): Extract<ProviderLoginEvent, { type: T }> | undefined {
  return events.findLast((event) => event.type === type) as
    | Extract<ProviderLoginEvent, { type: T }>
    | undefined;
}

/**
 * Drives one pi sign-in flow. pi decides the steps (device code, browser sign-in, pasted
 * code, API key, choices); this dialog renders whichever step the Host reports.
 */
export function ProviderLoginDialog({
  open,
  providerName,
  status,
  allowEmptySecret = false,
  emptySecretHint,
  onPoll,
  onRespond,
  onCancel,
  onRetry,
  onClose,
  onSuccess,
  pollIntervalMs = DEFAULT_POLL_MS,
}: {
  open: boolean;
  providerName: string;
  status: ProviderLoginStatus | null;
  /** Accept an empty secret, e.g. OpenCode Zen's keyless free tier. */
  allowEmptySecret?: boolean;
  emptySecretHint?: string;
  onPoll: () => Promise<ProviderLoginStatus | null>;
  onRespond: (promptId: string, value: string) => Promise<ProviderLoginStatus>;
  onCancel: () => Promise<void> | void;
  onRetry: () => Promise<void> | void;
  onClose: () => void;
  onSuccess: () => void;
  pollIntervalMs?: number;
}) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState<ProviderLoginStatus | null>(status);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [copied, setCopied] = useState(false);
  const pollInFlight = useRef(false);
  const onPollRef = useRef(onPoll);
  const onSuccessRef = useRef(onSuccess);
  const onCloseRef = useRef(onClose);
  onPollRef.current = onPoll;
  onSuccessRef.current = onSuccess;
  onCloseRef.current = onClose;

  useEffect(() => setCurrent(status), [status]);
  useEffect(() => {
    if (!open) {
      setValue("");
      setSubmitting(false);
      setCanceling(false);
      setCopied(false);
    }
  }, [open]);
  useEffect(() => setValue(""), [current?.prompt?.id]);

  const active = current?.state === "running" || current?.state === "awaiting_input";

  useEffect(() => {
    if (!open || !active) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled || pollInFlight.current) return;
      pollInFlight.current = true;
      try {
        const next = await onPollRef.current();
        if (!cancelled) setCurrent(next);
      } catch {
        // A transient Host error keeps the last known step on screen.
      } finally {
        pollInFlight.current = false;
      }
    };
    const id = window.setInterval(() => void poll(), pollIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open, active, pollIntervalMs]);

  useEffect(() => {
    if (!open || current?.state !== "succeeded") return;
    onSuccessRef.current();
    const id = window.setTimeout(() => onCloseRef.current(), SUCCESS_CLOSE_MS);
    return () => window.clearTimeout(id);
  }, [open, current?.state]);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(id);
  }, [copied]);

  const respond = async (promptId: string, answer: string) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      setCurrent(await onRespond(promptId, answer));
    } catch {
      setCurrent(await onPollRef.current().catch(() => current));
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async () => {
    if (canceling) return;
    setCanceling(true);
    try {
      if (active) await onCancel();
      onClose();
    } finally {
      setCanceling(false);
    }
  };

  const events = current?.events ?? [];
  const deviceCode = latest(events, "device_code");
  const authUrl = latest(events, "auth_url");
  const authHref = authUrl ? safeUrl(authUrl.url) : null;
  const deviceHref = deviceCode ? safeUrl(deviceCode.verificationUri) : null;
  const progress = latest(events, "progress");
  const infos = events.filter(
    (event): event is Extract<ProviderLoginEvent, { type: "info" }> => event.type === "info",
  );
  const prompt = current?.state === "awaiting_input" ? current.prompt : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) void cancel();
      }}
    >
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl" showCloseButton>
        <div className="border-b px-5 py-4 pr-12">
          <DialogTitle className="text-base font-semibold">
            {t("providers.login.title", { name: providerName })}
          </DialogTitle>
          <p className="mt-1 text-sm text-muted-foreground">{t("providers.login.description")}</p>
        </div>

        {current?.state === "succeeded" ? (
          <div className="flex items-center gap-3 px-5 py-8 text-sm">
            <ShieldCheck className="size-5 text-emerald-600 dark:text-emerald-400" />
            <div>
              <div className="font-medium">{t("providers.login.successTitle")}</div>
              <div className="text-muted-foreground">{t("providers.login.successBody")}</div>
            </div>
          </div>
        ) : current?.state === "failed" || current?.state === "cancelled" ? (
          <div className="space-y-4 px-5 py-5">
            <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
              {current.error || t("providers.login.failed")}
            </p>
            <div className="flex gap-2">
              <Button type="button" onClick={() => void onRetry()}>
                {t("providers.login.retry")}
              </Button>
              <Button type="button" variant="outline" onClick={onClose}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-4 px-5 py-5 text-sm [overflow-wrap:anywhere]">
              {infos.map((info, index) => (
                <div key={index} className="space-y-1 text-muted-foreground">
                  <p>{info.message}</p>
                  {info.links?.map((link) => {
                    const href = safeUrl(link.url);
                    return href ? (
                      <Button
                        key={link.url}
                        type="button"
                        size="sm"
                        variant="link"
                        className="h-auto p-0"
                        onClick={() => openExternalLink(href)}
                      >
                        {link.label || urlHost(href)}
                      </Button>
                    ) : null;
                  })}
                </div>
              ))}

              {deviceCode && (
                <div className="grid gap-3 rounded-lg border bg-muted/40 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
                  <div className="space-y-2">
                    <div className="font-medium">{t("providers.login.deviceCodeHelp")}</div>
                    {deviceHref && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => openExternalLink(deviceHref)}
                      >
                        <ExternalLink className="size-3.5" />
                        {urlHost(deviceHref)}
                      </Button>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void copyTextToClipboard(deviceCode.userCode).then(() => setCopied(true))
                    }
                    className="flex items-center gap-2 rounded-md px-2 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={t("providers.login.copyCodeAria", { code: deviceCode.userCode })}
                  >
                    <span
                      className="font-mono text-2xl font-semibold tracking-[0.18em]"
                      style={{ fontFamily: "OpenGUITerminal, ui-monospace, monospace" }}
                    >
                      {deviceCode.userCode}
                    </span>
                    {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                  </button>
                </div>
              )}

              {authHref && (
                <div className="space-y-2">
                  {authUrl?.instructions && (
                    <p className="text-muted-foreground">{authUrl.instructions}</p>
                  )}
                  <Button type="button" onClick={() => openExternalLink(authHref)}>
                    <ExternalLink className="size-4" />
                    {t("providers.login.openSignIn")}
                  </Button>
                </div>
              )}

              {prompt?.type === "select" && (
                <fieldset className="space-y-2">
                  <legend className="mb-2 font-medium">{prompt.message}</legend>
                  {prompt.options.map((option) => (
                    <Button
                      key={option.id}
                      type="button"
                      variant="outline"
                      className="h-auto w-full flex-col items-start gap-0.5 py-2 text-left whitespace-normal"
                      disabled={submitting}
                      onClick={() => void respond(prompt.id, option.id)}
                    >
                      <span>{option.label}</span>
                      {option.description && (
                        <span className="text-xs font-normal text-muted-foreground">
                          {option.description}
                        </span>
                      )}
                    </Button>
                  ))}
                </fieldset>
              )}

              {prompt && prompt.type !== "select" && (
                <form
                  className="space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void respond(prompt.id, value.trim());
                  }}
                >
                  <label className="block font-medium" htmlFor="provider-login-input">
                    {prompt.message}
                  </label>
                  <Input
                    id="provider-login-input"
                    autoFocus
                    autoComplete="off"
                    type={prompt.type === "secret" ? "password" : "text"}
                    value={value}
                    placeholder={prompt.placeholder}
                    onChange={(event) => setValue(event.target.value)}
                  />
                  {prompt.type === "secret" && allowEmptySecret && emptySecretHint && (
                    <p className="text-xs text-muted-foreground">{emptySecretHint}</p>
                  )}
                  <Button
                    type="submit"
                    disabled={
                      submitting ||
                      (!value.trim() && !(prompt.type === "secret" && allowEmptySecret))
                    }
                  >
                    {submitting && <Loader2 className="size-4 animate-spin" />}
                    {t("providers.login.submit")}
                  </Button>
                </form>
              )}

              {!prompt && !deviceCode && !authHref && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {progress?.message ?? t("providers.login.waiting", { name: providerName })}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t px-5 py-3">
              <span className="text-xs text-muted-foreground">
                {deviceCode || authHref ? t("providers.login.polling") : ""}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={canceling}
                onClick={() => void cancel()}
              >
                <X className="size-3.5" />
                {t("providers.login.stop")}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
