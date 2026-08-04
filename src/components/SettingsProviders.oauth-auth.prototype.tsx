/**
 * PROTOTYPE ONLY — throwaway OAuth authorization dialog directions.
 * Question: What should the device-code OAuth dialog look like?
 * Switch with ?variant=A|B|C. Not production code.
 */
import { Check, Copy, ExternalLink, Loader2, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  PrototypeVariantSwitcher,
  type PrototypeVariantOption,
} from "@/components/prototype/PrototypeVariantSwitcher";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type DemoPhase = "pending" | "success" | "expired" | "canceled";

const FIXTURE = {
  providerTitle: "ChatGPT",
  userCode: "WDJB-MJHT",
  verificationUri: "https://auth.openai.com/codex/device",
  expiresInLabel: "14:32",
};

const VARIANTS: readonly PrototypeVariantOption[] = [
  { key: "A", label: "Code pedestal" },
  { key: "B", label: "Split checklist" },
  { key: "C", label: "Challenge strip" },
] as const;

function useVariantParam() {
  const initial = new URLSearchParams(window.location.search).get("variant")?.toUpperCase() || "A";
  const [variant, setVariant] = useState(
    VARIANTS.some((item) => item.key === initial) ? initial : "A",
  );

  const change = (key: string) => {
    setVariant(key);
    const url = new URL(window.location.href);
    url.searchParams.set("variant", key);
    window.history.replaceState({}, "", url);
  };

  return [variant, change] as const;
}

function useCopyFeedback(value: string) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(id);
  }, [copied]);
  return {
    copied,
    copy: async () => {
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        // prototype: ignore clipboard failures
      }
      setCopied(true);
    },
  };
}

function DemoChrome({
  phase,
  onPhase,
  children,
}: {
  phase: DemoPhase;
  onPhase: (phase: DemoPhase) => void;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <div className="border-b border-border bg-muted/30 px-4 py-3">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs font-medium tracking-wide text-amber-700 dark:text-amber-300">
              PROTOTYPE · oauth device auth
            </div>
            <div className="text-sm text-muted-foreground">
              Fake Providers backdrop. Dialogs are local stubs (no Host calls).
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-muted-foreground">Demo state</span>
            {(["pending", "success", "expired", "canceled"] as const).map((item) => (
              <Button
                key={item}
                type="button"
                size="xs"
                variant={phase === item ? "default" : "outline"}
                onClick={() => onPhase(item)}
              >
                {item}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <div className="mx-auto grid max-w-5xl gap-5 px-4 py-6 md:grid-cols-[13rem_minmax(0,1fr)]">
        <aside className="hidden space-y-1 md:block">
          {["General", "Models", "Integrations"].map((label, index) => (
            <div
              key={label}
              className={cn(
                "rounded-md px-3 py-2 text-sm",
                index === 1
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground",
              )}
            >
              {label}
            </div>
          ))}
        </aside>
        <main className="rounded-lg border p-5">
          <div className="mb-5 space-y-1 border-b pb-4">
            <h1 className="text-lg font-semibold">Models</h1>
            <p className="text-sm text-muted-foreground">
              Connect models used by the OpenGUI agent.
            </p>
          </div>
          <div className="space-y-3">
            <div className="space-y-3 rounded-lg border p-3">
              <div>
                <div className="text-sm font-medium">ChatGPT</div>
                <div className="text-xs text-muted-foreground">
                  Use your ChatGPT subscription with Codex models.
                </div>
              </div>
              <Button type="button" disabled>
                Sign in to ChatGPT
              </Button>
            </div>
            <div className="space-y-3 rounded-lg border p-3 opacity-60">
              <div>
                <div className="text-sm font-medium">SuperGrok proxy (experimental)</div>
                <div className="text-xs text-muted-foreground">
                  Experimental subscription access through a third-party OAuth client.
                </div>
              </div>
              <Button type="button" variant="outline" disabled>
                Authorize third-party OAuth client
              </Button>
            </div>
          </div>
        </main>
      </div>

      {children}

      <div className="fixed bottom-16 left-1/2 z-[90] w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 rounded-md border border-border bg-card/95 px-3 py-2 font-mono text-[11px] text-muted-foreground shadow-sm backdrop-blur">
        state = {"{"} phase: <span className="text-foreground">{phase}</span>, code:{" "}
        <span className="text-foreground">{FIXTURE.userCode}</span>, autoPoll: true, cancel:
        local-only {"}"}
      </div>
    </div>
  );
}

/** A — Code pedestal: giant code is the only loud element. */
function VariantA({
  phase,
  onCancel,
  onRetry,
}: {
  phase: DemoPhase;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const { copied, copy } = useCopyFeedback(FIXTURE.userCode);
  const open = phase === "pending" || phase === "expired" || phase === "success";

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="sm:max-w-md" showCloseButton>
        <DialogTitle className="pr-8 text-base font-semibold">
          Sign in to {FIXTURE.providerTitle}
        </DialogTitle>
        <p className="text-sm text-muted-foreground">
          Open the verification page and enter this code.
        </p>

        {phase === "success" ? (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-4 text-sm text-emerald-700 dark:text-emerald-300">
            <ShieldCheck className="size-4 shrink-0" />
            Connected. You can close this.
          </div>
        ) : phase === "expired" ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm text-destructive">
              This code expired. Start again to get a new one.
            </div>
            <div className="flex gap-2">
              <Button type="button" onClick={onRetry}>
                Try again
              </Button>
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void copy()}
              className={cn(
                "group w-full rounded-xl border bg-muted/50 px-4 py-5 text-center transition-colors",
                "hover:border-foreground/25 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
              aria-label={`Authorization code ${FIXTURE.userCode}. Click to copy.`}
            >
              <div className="mb-2 text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
                Authorization code
              </div>
              <div
                className="font-mono text-3xl font-semibold tracking-[0.22em] text-foreground tabular-nums sm:text-4xl"
                style={{ fontFamily: "OpenGUITerminal, ui-monospace, monospace" }}
              >
                {FIXTURE.userCode}
              </div>
              <div className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? "Copied" : "Click to copy"}
              </div>
            </button>

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="button" variant="outline" className="flex-1" asChild>
                <a href={FIXTURE.verificationUri} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" />
                  Open verification page
                </a>
              </Button>
            </div>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Waiting for authorization… · expires in {FIXTURE.expiresInLabel}
            </div>

            <div className="flex justify-end border-t pt-3">
              <Button type="button" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** B — Split checklist: steps left, code right. */
function VariantB({
  phase,
  onCancel,
  onRetry,
}: {
  phase: DemoPhase;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const { copied, copy } = useCopyFeedback(FIXTURE.userCode);
  const open = phase === "pending" || phase === "expired" || phase === "success";

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl" showCloseButton>
        <div className="border-b px-5 py-4 pr-12">
          <DialogTitle className="text-base font-semibold">
            Authorize {FIXTURE.providerTitle}
          </DialogTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Complete these steps in your browser. OpenGUI waits automatically.
          </p>
        </div>

        {phase === "success" ? (
          <div className="flex items-center gap-3 px-5 py-8 text-sm">
            <ShieldCheck className="size-5 text-emerald-600 dark:text-emerald-400" />
            <div>
              <div className="font-medium">Authorization complete</div>
              <div className="text-muted-foreground">Models from ChatGPT are ready to use.</div>
            </div>
          </div>
        ) : phase === "expired" ? (
          <div className="space-y-4 px-5 py-5">
            <p className="text-sm text-destructive">Code expired before authorization finished.</p>
            <div className="flex gap-2">
              <Button type="button" onClick={onRetry}>
                Get a new code
              </Button>
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid sm:grid-cols-[1fr_13rem]">
            <ol className="space-y-4 px-5 py-5 text-sm">
              <li className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                  1
                </span>
                <div className="space-y-2">
                  <div className="font-medium">Open the verification page</div>
                  <Button type="button" size="sm" variant="outline" asChild>
                    <a href={FIXTURE.verificationUri} target="_blank" rel="noreferrer">
                      <ExternalLink className="size-3.5" />
                      auth.openai.com
                    </a>
                  </Button>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                  2
                </span>
                <div>
                  <div className="font-medium">Enter the code shown here</div>
                  <div className="text-muted-foreground">Copy it so you don’t retype.</div>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold text-muted-foreground">
                  3
                </span>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  Approve access — we detect it automatically
                </div>
              </li>
            </ol>

            <div className="flex flex-col justify-between gap-3 border-t bg-muted/40 px-4 py-5 sm:border-t-0 sm:border-l">
              <div>
                <div className="text-[10px] font-medium tracking-[0.16em] text-muted-foreground uppercase">
                  Code
                </div>
                <div
                  className="mt-2 font-mono text-2xl font-semibold tracking-[0.18em]"
                  style={{ fontFamily: "OpenGUITerminal, ui-monospace, monospace" }}
                >
                  {FIXTURE.userCode}
                </div>
              </div>
              <Button type="button" onClick={() => void copy()}>
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "Copied" : "Copy code"}
              </Button>
              <div className="text-[11px] text-muted-foreground">
                Expires in {FIXTURE.expiresInLabel}
              </div>
            </div>
          </div>
        )}

        {phase === "pending" && (
          <div className="flex items-center justify-between border-t px-5 py-3">
            <span className="text-xs text-muted-foreground">Polling every few seconds</span>
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              <X className="size-3.5" />
              Stop authorization
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** C — Challenge strip: terminal-like device challenge, status log. */
function VariantC({
  phase,
  onCancel,
  onRetry,
}: {
  phase: DemoPhase;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const { copied, copy } = useCopyFeedback(FIXTURE.userCode);
  const open = phase === "pending" || phase === "expired" || phase === "success";
  const log = useMemo(() => {
    if (phase === "success") {
      return [
        "device_code issued",
        "browser verification opened by user",
        "token exchange ok",
        "connected",
      ];
    }
    if (phase === "expired") {
      return ["device_code issued", "waiting…", "error: expired_token"];
    }
    if (phase === "canceled") {
      return ["device_code issued", "canceled by user"];
    }
    return ["device_code issued", "waiting for user authorization", "poll · authorization_pending"];
  }, [phase]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent
        className="gap-0 overflow-hidden border-border/80 bg-zinc-950 p-0 text-zinc-100 ring-zinc-800 sm:max-w-lg dark:bg-zinc-950"
        showCloseButton={false}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div>
            <DialogTitle className="font-mono text-xs tracking-[0.18em] text-zinc-400 uppercase">
              Device authorization
            </DialogTitle>
            <div className="mt-0.5 text-sm font-medium text-zinc-50">{FIXTURE.providerTitle}</div>
          </div>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="text-zinc-400 hover:bg-zinc-800 hover:text-zinc-50"
            onClick={onCancel}
            aria-label="Cancel authorization"
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="space-y-4 px-4 py-4">
          <div className="rounded-md border border-zinc-800 bg-black/40 p-3">
            <div className="mb-2 flex items-center justify-between text-[10px] tracking-wider text-zinc-500 uppercase">
              <span>user_code</span>
              <span>ttl {FIXTURE.expiresInLabel}</span>
            </div>
            <div className="flex items-center gap-2">
              <code
                className="flex-1 font-mono text-2xl tracking-[0.28em] text-lime-300 sm:text-3xl"
                style={{ fontFamily: "OpenGUITerminal, ui-monospace, monospace" }}
              >
                {FIXTURE.userCode}
              </code>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800"
                onClick={() => void copy()}
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              className="bg-zinc-100 text-zinc-950 hover:bg-white"
              asChild
            >
              <a href={FIXTURE.verificationUri} target="_blank" rel="noreferrer">
                <ExternalLink className="size-3.5" />
                Open verification URL
              </a>
            </Button>
            {phase === "expired" && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="border-zinc-700 bg-transparent text-zinc-100 hover:bg-zinc-900"
                onClick={onRetry}
              >
                Reissue code
              </Button>
            )}
            {phase === "pending" && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
                onClick={onCancel}
              >
                Stop
              </Button>
            )}
          </div>

          <div
            className="rounded-md border border-zinc-800 bg-black/50 p-3 font-mono text-[11px] leading-relaxed text-zinc-400"
            style={{ fontFamily: "OpenGUITerminal, ui-monospace, monospace" }}
          >
            {log.map((line, index) => (
              <div key={`${line}-${index}`} className="flex gap-2">
                <span className="text-zinc-600">$</span>
                <span
                  className={cn(
                    index === log.length - 1 && phase === "pending" && "text-amber-300",
                    index === log.length - 1 && phase === "success" && "text-lime-300",
                    index === log.length - 1 && phase === "expired" && "text-red-400",
                  )}
                >
                  {line}
                  {index === log.length - 1 && phase === "pending" ? " ▍" : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function OAuthAuthPrototypePage() {
  const [variant, setVariant] = useVariantParam();
  const [phase, setPhase] = useState<DemoPhase>("pending");

  return (
    <DemoChrome phase={phase} onPhase={setPhase}>
      {variant === "A" && (
        <VariantA
          phase={phase}
          onCancel={() => setPhase("canceled")}
          onRetry={() => setPhase("pending")}
        />
      )}
      {variant === "B" && (
        <VariantB
          phase={phase}
          onCancel={() => setPhase("canceled")}
          onRetry={() => setPhase("pending")}
        />
      )}
      {variant === "C" && (
        <VariantC
          phase={phase}
          onCancel={() => setPhase("canceled")}
          onRetry={() => setPhase("pending")}
        />
      )}
      <PrototypeVariantSwitcher variants={VARIANTS} current={variant} onChange={setVariant} />
    </DemoChrome>
  );
}
