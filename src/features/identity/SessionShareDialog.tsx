import { Check, Copy, Link2, Share2, Trash2, Users } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { copyTextToClipboard } from "@/lib/browser";
import { notifySuccess, notifyUnknownError } from "@/lib/notify";
import { createIdentityClient, type SessionShare, type SessionViewLink } from "./identity-client";
import { identityWorkspaceIsLocalBypass } from "./workspace-identity";
import { useWorkspaceState } from "@/hooks/use-agent-state";

type Principal = { type: "user" | "team"; id: string; name: string };
type OpenShareDetail = { sessionId: string; title: string };

export const OPEN_SESSION_SHARE_EVENT = "opengui:open-session-share";

export function openSessionShareDialog(sessionId: string, title: string) {
  window.dispatchEvent(
    new CustomEvent<OpenShareDetail>(OPEN_SESSION_SHARE_EVENT, { detail: { sessionId, title } }),
  );
}

function viewLink(token: string) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("view", token);
  return url.toString();
}

export function SessionShareDialog() {
  const { t, i18n } = useTranslation();
  const { activeWorkspace: workspace } = useWorkspaceState();
  const client = useMemo(
    () =>
      workspace?.authToken && !identityWorkspaceIsLocalBypass(workspace)
        ? createIdentityClient({ baseUrl: workspace.serverUrl, token: workspace.authToken })
        : null,
    [workspace],
  );
  const [session, setSession] = useState<OpenShareDetail | null>(null);
  const [principals, setPrincipals] = useState<Principal[]>([]);
  const [shares, setShares] = useState<SessionShare[]>([]);
  const [links, setLinks] = useState<SessionViewLink[]>([]);
  const [principalKey, setPrincipalKey] = useState("");
  const [role, setRole] = useState<"view" | "run" | "admin">("view");
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (detail: OpenShareDetail) => {
      if (!client) return;
      setBusy(true);
      try {
        const [available, currentShares, currentLinks] = await Promise.all([
          client.sharePrincipals(),
          client.sessionShares(detail.sessionId),
          client.sessionViewLinks(detail.sessionId),
        ]);
        setPrincipals([
          ...available.teams.map((item) => ({
            ...item,
            name: t("sessionShare.types.team"),
            type: "team" as const,
          })),
          ...available.users.map((item) => ({ ...item, type: "user" as const })),
        ]);
        setShares(currentShares);
        setLinks(currentLinks);
      } catch (error) {
        notifyUnknownError(error);
        setSession(null);
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  useEffect(() => {
    const open = (event: Event) => {
      if (!client) return;
      const detail = (event as CustomEvent<OpenShareDetail>).detail;
      setSession(detail);
      setCreatedUrl(null);
      void load(detail);
    };
    window.addEventListener(OPEN_SESSION_SHARE_EVENT, open);
    return () => window.removeEventListener(OPEN_SESSION_SHARE_EVENT, open);
  }, [client, load]);

  async function addShare(event: FormEvent) {
    event.preventDefault();
    if (!client || !session) return;
    const principal = principals.find((item) => `${item.type}:${item.id}` === principalKey);
    if (!principal) return;
    setBusy(true);
    try {
      await client.shareSession(session.sessionId, {
        granteeType: principal.type,
        granteeId: principal.id,
        role,
      });
      await load(session);
    } catch (error) {
      notifyUnknownError(error);
    } finally {
      setBusy(false);
    }
  }

  async function createLink() {
    if (!client || !session) return;
    setBusy(true);
    try {
      const link = await client.createSessionViewLink(session.sessionId);
      setCreatedUrl(viewLink(link.token));
      setLinks((current) => [link, ...current]);
    } catch (error) {
      notifyUnknownError(error);
    } finally {
      setBusy(false);
    }
  }

  const principalName = (share: SessionShare) =>
    principals.find((item) => item.type === share.granteeType && item.id === share.granteeId)
      ?.name ?? share.granteeId;

  return (
    <Dialog open={!!session} onOpenChange={(open) => !open && setSession(null)}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("sessionShare.title")}</DialogTitle>
          <DialogDescription>
            {t("sessionShare.description", { title: session?.title })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Users className="size-4 text-muted-foreground" />
              {t("sessionShare.people")}
            </div>
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(event) => void addShare(event)}
            >
              <Label className="sr-only" htmlFor="session-share-principal">
                {t("sessionShare.principal")}
              </Label>
              <Select
                value={principalKey}
                onValueChange={(value) => {
                  setPrincipalKey(value);
                  if (value.startsWith("user:") && role === "run") setRole("view");
                }}
              >
                <SelectTrigger id="session-share-principal" className="min-w-0 flex-1">
                  <SelectValue placeholder={t("sessionShare.choosePrincipal")} />
                </SelectTrigger>
                <SelectContent>
                  {principals.map((item) => (
                    <SelectItem key={`${item.type}:${item.id}`} value={`${item.type}:${item.id}`}>
                      {item.name} · {t(`sessionShare.types.${item.type}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={role} onValueChange={(value) => setRole(value as typeof role)}>
                <SelectTrigger className="sm:w-32" aria-label={t("sessionShare.access")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="view">{t("sessionShare.roles.view")}</SelectItem>
                  {!principalKey.startsWith("user:") && (
                    <SelectItem value="run">{t("sessionShare.roles.run")}</SelectItem>
                  )}
                  <SelectItem value="admin">{t("sessionShare.roles.admin")}</SelectItem>
                </SelectContent>
              </Select>
              <Button type="submit" disabled={!principalKey || busy}>
                <Share2 />
                {t("sessionShare.share")}
              </Button>
            </form>
            {shares.length === 0 ? (
              <p className="rounded-lg bg-muted/40 px-3 py-4 text-center text-xs text-muted-foreground">
                {t("sessionShare.private")}
              </p>
            ) : (
              <div className="divide-y rounded-lg border">
                {shares.map((share) => (
                  <div
                    key={`${share.granteeType}:${share.granteeId}`}
                    className="flex items-center gap-3 px-3 py-2.5"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">{principalName(share)}</span>
                    <Badge variant="outline">{t(`sessionShare.roles.${share.role}`)}</Badge>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("sessionShare.revokeShare", { name: principalName(share) })}
                      onClick={() => {
                        if (!client || !session) return;
                        void client
                          .revokeSessionShare(session.sessionId, share.granteeType, share.granteeId)
                          .then(() => setShares((items) => items.filter((item) => item !== share)))
                          .catch(notifyUnknownError);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-3 border-t pt-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Link2 className="size-4 text-muted-foreground" />
                  {t("sessionShare.viewLinks")}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("sessionShare.viewLinksHelp")}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void createLink()}
              >
                {t("sessionShare.createLink")}
              </Button>
            </div>
            {createdUrl && (
              <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-2">
                <code className="min-w-0 flex-1 truncate text-xs">{createdUrl}</code>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={t("identity.copyLink")}
                  onClick={() =>
                    void copyTextToClipboard(createdUrl).then(() => {
                      setCopied(true);
                      notifySuccess(t("identity.copied"));
                    })
                  }
                >
                  {copied ? <Check /> : <Copy />}
                </Button>
              </div>
            )}
            {links.length > 0 && (
              <div className="divide-y rounded-lg border">
                {links.map((link) => (
                  <div key={link.id} className="flex items-center gap-3 px-3 py-2.5">
                    <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                      {link.expiresAt
                        ? t("sessionShare.linkExpires", {
                            date: new Intl.DateTimeFormat(i18n.language, {
                              dateStyle: "medium",
                            }).format(link.expiresAt),
                          })
                        : t("sessionShare.noExpiry")}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("sessionShare.revokeLink")}
                      onClick={() => {
                        if (!client) return;
                        void client
                          .revokeSessionViewLink(link.id)
                          .then(() =>
                            setLinks((items) => items.filter((item) => item.id !== link.id)),
                          )
                          .catch(notifyUnknownError);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
