import { AlertTriangle, FolderOpen, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { PathGrant } from "./identity-client";
import { appendPathGrant, removePathGrant, replaceGrantAccess } from "./path-grants-state";

type GrantSubject = { kind: "member" | "apiKey"; id: string; name: string };

export function PathGrantRows({
  grants,
  onChange,
}: {
  grants: PathGrant[];
  onChange: (grants: PathGrant[]) => void;
}) {
  const { t } = useTranslation();
  if (grants.length === 0) {
    return (
      <div className="rounded-lg border border-dashed px-4 py-6 text-center">
        <p className="text-sm font-medium">{t("identity.pathGrants.noAccessTitle")}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t("identity.pathGrants.noAccessDescription")}
        </p>
      </div>
    );
  }
  return (
    <div className="divide-y rounded-lg border">
      {grants.map((grant, index) => (
        <div key={`${grant.root}:${index}`} className="flex items-center gap-2 p-2">
          <div className="min-w-0 flex-1">
            <span className="sr-only">{t("identity.pathGrants.root")}</span>
            <p className="truncate font-mono text-sm" title={grant.root}>
              {grant.root}
            </p>
          </div>
          <Select
            value={grant.access}
            onValueChange={(value) =>
              onChange(replaceGrantAccess(grants, index, value as PathGrant["access"]))
            }
          >
            <SelectTrigger
              className="w-36"
              aria-label={t("identity.pathGrants.accessFor", { path: grant.root })}
            >
              <SelectValue>
                {t(
                  grant.access === "read"
                    ? "identity.pathGrants.readOnly"
                    : "identity.pathGrants.readWrite",
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="read">{t("identity.pathGrants.readOnly")}</SelectItem>
              <SelectItem value="write">{t("identity.pathGrants.readWrite")}</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("identity.pathGrants.removePath", { path: grant.root })}
            onClick={() => onChange(removePathGrant(grants, index))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
    </div>
  );
}

export function PathGrantEditor({
  subject,
  load,
  save,
  onClose,
}: {
  subject: GrantSubject;
  load: () => Promise<PathGrant[]>;
  save: (grants: PathGrant[]) => Promise<PathGrant[]>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [grants, setGrants] = useState<PathGrant[]>([]);
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void load()
      .then((value) => {
        if (!cancelled) setGrants(value);
      })
      .catch(() => {
        if (!cancelled) setError(t("identity.pathGrants.loadError"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load, t]);

  function add(event?: FormEvent) {
    event?.preventDefault();
    if (!path.trim()) return;
    setGrants((current) => appendPathGrant(current, path));
    setPath("");
  }

  async function browse() {
    const selected = await new Promise<string | null>((resolve) => {
      window.dispatchEvent(
        new CustomEvent("opengui:open-project-path-dialog", {
          detail: { resolve, initialPath: path.trim() || undefined },
        }),
      );
    });
    if (selected) setPath(selected);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("identity.pathGrants.title", { name: subject.name })}</DialogTitle>
          <DialogDescription>{t("identity.pathGrants.description")}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="space-y-2" role="status" aria-label={t("common.loading")}>
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-foreground">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />
              <p className="leading-5">{t("identity.pathGrants.shellDisabled")}</p>
            </div>
            <PathGrantRows grants={grants} onChange={setGrants} />
            <form className="flex flex-col gap-2 sm:flex-row" onSubmit={add}>
              <div className="min-w-0 flex-1">
                <Label htmlFor="grant-path" className="sr-only">
                  {t("identity.pathGrants.path")}
                </Label>
                <Input
                  id="grant-path"
                  className="font-mono"
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  placeholder={t("identity.pathGrants.pathPlaceholder")}
                  autoComplete="off"
                />
              </div>
              <Button type="button" variant="outline" onClick={() => void browse()}>
                <FolderOpen />
                {t("common.browse")}
              </Button>
              <Button type="submit" variant="outline" disabled={!path.trim()}>
                <Plus />
                {t("identity.pathGrants.addPath")}
              </Button>
            </form>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={loading || saving || !!error}
            onClick={() => {
              setSaving(true);
              setError(null);
              void save(grants)
                .then((canonical) => {
                  setGrants(canonical);
                  onClose();
                })
                .catch(() => setError(t("identity.pathGrants.saveError")))
                .finally(() => setSaving(false));
            }}
          >
            {saving ? t("identity.pathGrants.saving") : t("identity.pathGrants.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
