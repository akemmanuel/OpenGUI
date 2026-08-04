import { Check, Copy, ExternalLink, Loader2, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { copyTextToClipboard, openExternalLink } from "@/lib/browser";
import type { CodexAuthStatus } from "@/protocol/host-types";

const DEFAULT_POLL_MS = 5_000;
const SUCCESS_CLOSE_MS = 1_200;

export type DeviceAuthPending = {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
};

type DialogPhase = "pending" | "success" | "expired";

function isExpiredError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /expir/i.test(message);
}

function formatRemaining(expiresAt: number, now: number) {
  const remainingMs = Math.max(0, expiresAt - now);
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function DeviceAuthDialog({
  open,
  title,
  pending,
  onPoll,
  onCancel,
  onClose,
  onSuccess,
  onRetry,
  pollIntervalMs = DEFAULT_POLL_MS,
}: {
  open: boolean;
  title: string;
  pending: DeviceAuthPending | null;
  onPoll: () => Promise<CodexAuthStatus>;
  onCancel: () => Promise<void> | void;
  onClose: () => void;
  onSuccess: (status: CodexAuthStatus) => void;
  onRetry: () => Promise<void> | void;
  pollIntervalMs?: number;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<DialogPhase>("pending");
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [canceling, setCanceling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const pollInFlight = useRef(false);
  const onPollRef = useRef(onPoll);
  const onSuccessRef = useRef(onSuccess);
  const onCloseRef = useRef(onClose);
  onPollRef.current = onPoll;
  onSuccessRef.current = onSuccess;
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) {
      setPhase("pending");
      setCopied(false);
      setCanceling(false);
      setRetrying(false);
      return;
    }
    if (pending) setPhase("pending");
  }, [open, pending?.userCode, pending?.expiresAt]);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(id);
  }, [copied]);

  useEffect(() => {
    if (!open || phase !== "pending" || !pending) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [open, phase, pending]);

  useEffect(() => {
    if (!open || phase !== "pending" || !pending) return;
    if (Date.now() >= pending.expiresAt) setPhase("expired");
  }, [open, phase, pending, now]);

  useEffect(() => {
    if (!open || phase !== "pending" || !pending) return;

    let cancelled = false;
    const poll = async () => {
      if (cancelled || pollInFlight.current) return;
      if (Date.now() >= pending.expiresAt) {
        setPhase("expired");
        return;
      }
      pollInFlight.current = true;
      try {
        const status = await onPollRef.current();
        if (cancelled) return;
        if (status.connected) {
          setPhase("success");
          onSuccessRef.current(status);
          return;
        }
        if (!status.pending) setPhase("expired");
      } catch (error) {
        if (cancelled) return;
        if (isExpiredError(error)) setPhase("expired");
      } finally {
        pollInFlight.current = false;
      }
    };

    void poll();
    const id = window.setInterval(() => void poll(), pollIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open, phase, pending?.userCode, pending?.expiresAt, pollIntervalMs]);

  useEffect(() => {
    if (phase !== "success" || !open) return;
    const id = window.setTimeout(() => onCloseRef.current(), SUCCESS_CLOSE_MS);
    return () => window.clearTimeout(id);
  }, [phase, open]);

  const handleCancel = async () => {
    if (canceling || phase === "success") return;
    setCanceling(true);
    try {
      await onCancel();
      onClose();
    } finally {
      setCanceling(false);
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      if (phase === "success") onClose();
      else void handleCancel();
    }
  };

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await onRetry();
      setPhase("pending");
    } finally {
      setRetrying(false);
    }
  };

  const handleCopy = async () => {
    if (!pending) return;
    await copyTextToClipboard(pending.userCode);
    setCopied(true);
  };

  const remaining = pending ? formatRemaining(pending.expiresAt, now) : "0:00";
  const verificationHost = (() => {
    if (!pending) return "";
    try {
      return new URL(pending.verificationUri).host;
    } catch {
      return pending.verificationUri;
    }
  })();

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl" showCloseButton>
        <div className="border-b px-5 py-4 pr-12">
          <DialogTitle className="text-base font-semibold">{title}</DialogTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("providers.deviceAuth.description")}
          </p>
        </div>

        {phase === "success" ? (
          <div className="flex items-center gap-3 px-5 py-8 text-sm">
            <ShieldCheck className="size-5 text-emerald-600 dark:text-emerald-400" />
            <div>
              <div className="font-medium">{t("providers.deviceAuth.successTitle")}</div>
              <div className="text-muted-foreground">{t("providers.deviceAuth.successBody")}</div>
            </div>
          </div>
        ) : phase === "expired" || !pending ? (
          <div className="space-y-4 px-5 py-5">
            <p className="text-sm text-destructive">{t("providers.deviceAuth.expired")}</p>
            <div className="flex gap-2">
              <Button type="button" disabled={retrying} onClick={() => void handleRetry()}>
                {t("providers.deviceAuth.retry")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={canceling}
                onClick={() => void handleCancel()}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid sm:grid-cols-[1fr_13rem]">
              <ol className="space-y-4 px-5 py-5 text-sm">
                <li className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                    1
                  </span>
                  <div className="space-y-2">
                    <div className="font-medium">{t("providers.deviceAuth.stepOpen")}</div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => openExternalLink(pending.verificationUri)}
                    >
                      <ExternalLink className="size-3.5" />
                      {verificationHost || t("providers.deviceAuth.openPage")}
                    </Button>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                    2
                  </span>
                  <div>
                    <div className="font-medium">{t("providers.deviceAuth.stepEnterCode")}</div>
                    <div className="text-muted-foreground">
                      {t("providers.deviceAuth.stepEnterCodeHelp")}
                    </div>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold text-muted-foreground">
                    3
                  </span>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    {t("providers.deviceAuth.stepWait")}
                  </div>
                </li>
              </ol>

              <div className="flex flex-col justify-between gap-3 border-t bg-muted/40 px-4 py-5 sm:border-t-0 sm:border-l">
                <div>
                  <div className="text-[10px] font-medium tracking-[0.16em] text-muted-foreground uppercase">
                    {t("providers.deviceAuth.codeLabel")}
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleCopy()}
                    className="mt-2 w-full rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={t("providers.deviceAuth.copyCodeAria", { code: pending.userCode })}
                  >
                    <div
                      className="font-mono text-2xl font-semibold tracking-[0.18em]"
                      style={{ fontFamily: "OpenGUITerminal, ui-monospace, monospace" }}
                    >
                      {pending.userCode}
                    </div>
                  </button>
                </div>
                <Button type="button" onClick={() => void handleCopy()}>
                  {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                  {copied ? t("providers.deviceAuth.copied") : t("providers.deviceAuth.copyCode")}
                </Button>
                <div className="text-[11px] text-muted-foreground">
                  {t("providers.deviceAuth.expiresIn", { time: remaining })}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between border-t px-5 py-3">
              <span className="text-xs text-muted-foreground">
                {t("providers.deviceAuth.polling")}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={canceling}
                onClick={() => void handleCancel()}
              >
                <X className="size-3.5" />
                {t("providers.deviceAuth.stop")}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
