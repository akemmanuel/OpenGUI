import { AlertCircle, Eye, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import openguiLogoDark from "@/../assets/opengui-dark.svg";
import openguiLogoLight from "@/../assets/opengui-light.svg";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import type { HostSessionSnapshot } from "@/protocol/host-types";
import { createIdentityClient } from "./identity-client";

type TranscriptItem =
  | { id: string; kind: "user" | "assistant"; text: string; actor?: string }
  | { id: string; kind: "tool"; text: string };

function transcript(snapshot: HostSessionSnapshot): TranscriptItem[] {
  return snapshot.entries.flatMap((entry): TranscriptItem[] => {
    const text = typeof entry.payload.text === "string" ? entry.payload.text : "";
    if (entry.kind === "user_message" && text) {
      const actor = entry.payload.actor as { displayName?: unknown } | undefined;
      return [
        {
          id: entry.id,
          kind: "user" as const,
          text,
          actor: typeof actor?.displayName === "string" ? actor.displayName : undefined,
        },
      ];
    }
    if (entry.kind === "assistant_message" && text) {
      return [{ id: entry.id, kind: "assistant" as const, text }];
    }
    if (entry.kind === "tool_call") {
      const name = typeof entry.payload.name === "string" ? entry.payload.name : "tool";
      return [{ id: entry.id, kind: "tool" as const, text: name }];
    }
    return [];
  });
}

export function readViewLinkToken(url = window.location.href) {
  return new URL(url).searchParams.get("view")?.trim() || null;
}

export function ViewLinkScreen({ token }: { token: string }) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<HostSessionSnapshot | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void createIdentityClient({ baseUrl: window.location.origin })
      .resolveSessionViewLink(token)
      .then((value) => {
        if (!cancelled) setSnapshot(value.session);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const items = useMemo(() => (snapshot ? transcript(snapshot) : []), [snapshot]);

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <picture className="shrink-0">
            <img src={openguiLogoDark} alt="OpenGUI" className="hidden h-5 dark:block" />
            <img src={openguiLogoLight} alt="OpenGUI" className="h-5 dark:hidden" />
          </picture>
          <div className="min-w-0 flex-1 border-l pl-3">
            <h1 className="truncate text-sm font-medium">
              {snapshot?.title || t("viewLink.loadingTitle")}
            </h1>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Eye className="size-3" />
              {t("viewLink.readOnly")}
            </p>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        {failed ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{t("viewLink.invalid")}</AlertDescription>
          </Alert>
        ) : !snapshot ? (
          <div className="space-y-6" role="status" aria-label={t("common.loading")}>
            <Skeleton className="h-20 w-3/4" />
            <Skeleton className="ml-auto h-16 w-2/3" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : items.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">{t("viewLink.empty")}</p>
        ) : (
          <div className="space-y-6">
            {items.map((item) =>
              item.kind === "tool" ? (
                <div
                  key={item.id}
                  className="flex items-center gap-2 border-y py-2 text-xs text-muted-foreground"
                >
                  <Wrench className="size-3.5" />
                  {t("viewLink.usedTool", { tool: item.text })}
                </div>
              ) : (
                <article
                  key={item.id}
                  className={
                    item.kind === "user"
                      ? "ml-auto max-w-[85%] rounded-xl bg-muted px-4 py-3"
                      : "max-w-none"
                  }
                >
                  <p className="mb-1 text-xs font-medium text-muted-foreground">
                    {item.kind === "user"
                      ? item.actor || t("viewLink.user")
                      : t("viewLink.assistant")}
                  </p>
                  <MarkdownRenderer content={item.text} />
                </article>
              ),
            )}
          </div>
        )}
      </div>
      <footer className="mx-auto max-w-3xl border-t px-4 py-5 text-center text-xs text-muted-foreground">
        {t("viewLink.footer")}
      </footer>
    </main>
  );
}
