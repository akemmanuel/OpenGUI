import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FolderInput,
  Globe,
  Loader2,
  PackagePlus,
  RefreshCw,
  ShieldCheck,
  Star,
  Terminal,
  Trash2,
  TrendingUp,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { BaseDialog } from "@/components/ui/base-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type {
  InstalledPluginInfo,
  PluginCatalogAuditResponse,
  PluginCatalogDetailResponse,
  PluginCatalogEntry,
} from "@/types/electron";

export type PluginInstallState = {
  exact?: InstalledPluginInfo;
  conflict?: InstalledPluginInfo;
};

export type InstallPhase = "starting" | "running" | "completed" | "failed";
export type InstallProgress = { phase: InstallPhase; rawLines: string[]; skillName: string };

export function PluginCard({
  plugin,
  installState,
  busy,
  onInstall,
  onUpdate,
  onRemove,
  onClick,
}: {
  plugin: PluginCatalogEntry;
  installState: PluginInstallState;
  busy: boolean;
  onInstall: (plugin: PluginCatalogEntry) => void;
  onUpdate: (installed: InstalledPluginInfo) => void;
  onRemove: (installed: InstalledPluginInfo) => void;
  onClick: (plugin: PluginCatalogEntry) => void;
}) {
  const { t } = useTranslation();
  const isHot = plugin.change != null && plugin.change > 0;
  const installed = installState.exact;
  const conflict = !installed ? installState.conflict : undefined;

  return (
    <button
      type="button"
      onClick={() => onClick(plugin)}
      className="group flex flex-col gap-3 rounded-xl border bg-card p-4 text-left transition-all hover:border-primary/50 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold">{plugin.name}</h3>
            {isHot && (
              <Badge
                variant="default"
                className="shrink-0 bg-orange-500/15 text-orange-600 text-[10px] px-1.5 py-0 hover:bg-orange-500/15"
              >
                <TrendingUp className="size-2.5 mr-0.5" />
                HOT
              </Badge>
            )}
            {installed && (
              <Badge variant="secondary" className="shrink-0 text-[10px] px-1.5 py-0">
                <CheckCircle2 className="size-2.5 mr-0.5" />
                {t("settings.marketplace.installed")}
              </Badge>
            )}
            {conflict && (
              <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0">
                <AlertCircle className="size-2.5 mr-0.5" />
                {t("settings.marketplace.nameConflict")}
              </Badge>
            )}
          </div>
          {plugin.slug && plugin.slug !== plugin.name && (
            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{plugin.slug}</p>
          )}
          <p className="mt-1.5 text-[11px] text-muted-foreground/60 font-mono truncate">
            {plugin.source}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground/70">
          <Star className="size-3 inline mr-0.5 -mt-0.5" />
          {plugin.installs.toLocaleString()} {t("settings.marketplace.installsLabel")}
        </span>
        <div className="flex gap-1.5">
          {installed ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onUpdate(installed);
                }}
              >
                {busy ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <RefreshCw className="size-3" />
                )}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(installed);
                }}
              >
                <Trash2 className="size-3" />
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              variant={conflict ? "outline" : "default"}
              className="h-7 px-3 text-xs"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onInstall(plugin);
              }}
            >
              {busy ? <Loader2 className="size-3 animate-spin mr-1" /> : null}
              {busy ? t("settings.marketplace.installing") : t("settings.marketplace.install")}
            </Button>
          )}
        </div>
      </div>
    </button>
  );
}

export function InstallFlowDialog({
  open,
  onOpenChange,
  plugin,
  directory,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plugin: PluginCatalogEntry | null;
  directory: string | undefined;
  onConfirm: (source: string, globalScope: boolean) => void;
}) {
  const { t } = useTranslation();
  const [globalScope, setGlobalScope] = useState(false);
  if (!plugin) return null;

  return (
    <BaseDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span className="inline-flex items-center gap-2">
          <PackagePlus className="size-4" />
          {t("settings.marketplace.install")} {plugin.name}
        </span>
      }
      description={
        <span className="inline-flex items-center gap-1.5">
          <Globe className="size-3" />
          {plugin.source}/{plugin.slug}
        </span>
      }
      className="sm:max-w-sm"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <label
            htmlFor="global-scope"
            className="flex items-center gap-2 text-xs text-muted-foreground"
          >
            <input
              type="checkbox"
              id="global-scope"
              checked={globalScope}
              onChange={(e) => setGlobalScope(e.target.checked)}
              className="size-3.5 rounded border-gray-300"
            />
            <Globe className="size-3.5" />
            {t("settings.marketplace.globalScope")}
          </label>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              <XCircle className="size-3.5 mr-1" />
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                onConfirm(
                  plugin.source ? `${plugin.source}@${plugin.slug}` : plugin.id || plugin.slug,
                  globalScope,
                );
                onOpenChange(false);
              }}
            >
              <PackagePlus className="size-3.5 mr-1" />
              {t("settings.marketplace.install")}
            </Button>
          </div>
        </div>
      }
    >
      <p className="flex gap-2 text-sm text-muted-foreground">
        <FolderInput className="mt-0.5 size-4 shrink-0" />
        <span>
          {globalScope
            ? t("settings.marketplace.installScopeHelp").replace(
                "Project installs",
                "Installs globally to",
              )
            : directory
              ? t("settings.marketplace.installScopeHelp")
              : t("settings.marketplace.installScopeHelp").replace(
                  "Project installs",
                  "No project directory — installing globally",
                )}
        </span>
      </p>
    </BaseDialog>
  );
}

export function PluginDetailDialog({
  plugin,
  detailLoading,
  detailData,
  auditData,
  installState,
  busy,
  onClose,
  onInstall,
  onUpdate,
  onRemove,
}: {
  plugin: PluginCatalogEntry | null;
  detailLoading: boolean;
  detailData: PluginCatalogDetailResponse | null;
  auditData: PluginCatalogAuditResponse | null;
  installState: PluginInstallState;
  busy: boolean;
  onClose: () => void;
  onInstall: () => void;
  onUpdate: (installed: InstalledPluginInfo) => void;
  onRemove: (installed: InstalledPluginInfo) => void;
}) {
  const { t } = useTranslation();
  return (
    <BaseDialog
      open={plugin !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={plugin?.name || ""}
      description={plugin ? `${plugin.source}/${plugin.slug}` : ""}
      className="sm:max-w-2xl max-h-[80vh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden pr-3"
      headerClassName="border-b pb-4 pr-8"
      bodyClassName="overflow-y-auto pr-3"
      footerClassName="border-t bg-background pt-4"
      footer={
        plugin && (
          <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Star className="size-3" />
              {plugin.installs.toLocaleString()} {t("settings.marketplace.installsLabel")}
              {plugin.installUrl && (
                <a
                  href={plugin.installUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  <ExternalLink className="size-3" />
                  {t("settings.marketplace.source")}
                </a>
              )}
            </div>
            <div className="flex flex-wrap gap-2 sm:justify-end">
              {installState.exact ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => onUpdate(installState.exact!)}
                  >
                    <RefreshCw className="size-3.5 mr-1" />
                    {t("settings.skills.update")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={busy}
                    onClick={() => onRemove(installState.exact!)}
                  >
                    <Trash2 className="size-3.5 mr-1" />
                    {t("settings.skills.remove")}
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant={installState.conflict ? "outline" : "default"}
                  disabled={busy}
                  onClick={onInstall}
                >
                  {busy ? (
                    <Loader2 className="size-3 animate-spin mr-1" />
                  ) : (
                    <PackagePlus className="size-3.5 mr-1" />
                  )}
                  {t("settings.marketplace.install")}
                </Button>
              )}
            </div>
          </div>
        )
      }
    >
      {detailLoading ? (
        <div className="flex justify-center py-8">
          <Spinner className="size-5" />
        </div>
      ) : detailData ? (
        <div className="space-y-4">
          {detailData.files?.map((file) => (
            <details key={file.path} className="group rounded-lg border bg-muted/30">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
                <Terminal className="size-3" />
                <span className="flex-1 truncate">{file.path}</span>
              </summary>
              <pre className="max-h-80 overflow-auto border-t bg-muted p-3 text-xs leading-relaxed whitespace-pre-wrap break-words">
                {file.contents}
              </pre>
            </details>
          ))}
          {auditData?.audits && auditData.audits.length > 0 && (
            <div className="space-y-2">
              <h4 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                <ShieldCheck className="size-3.5" />
                {t("settings.marketplace.audit")}
              </h4>
              <div className="space-y-1.5">
                {auditData.audits.map((a) => (
                  <div
                    key={a.slug}
                    className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
                  >
                    <Badge
                      variant={
                        a.status === "pass"
                          ? "secondary"
                          : a.status === "warn"
                            ? "default"
                            : "destructive"
                      }
                      className="text-[10px] px-1.5 py-0"
                    >
                      {a.status}
                    </Badge>
                    <span className="font-medium">{a.provider}</span>
                    <span className="text-muted-foreground">{a.summary}</span>
                    {a.riskLevel && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 ml-auto">
                        {a.riskLevel}
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </BaseDialog>
  );
}

export function InstallProgressDialog({
  open,
  onOpenChange,
  progress,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  progress: InstallProgress;
}) {
  const { t } = useTranslation();
  const [showDetails, setShowDetails] = useState(false);
  return (
    <BaseDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span className="inline-flex items-center gap-2">
          {progress.phase === "completed" ? (
            <CheckCircle2 className="size-4 text-emerald-500" />
          ) : progress.phase === "failed" ? (
            <XCircle className="size-4 text-destructive" />
          ) : (
            <PackagePlus className="size-4" />
          )}
          {progress.phase === "completed"
            ? t("settings.marketplace.progressComplete")
            : progress.phase === "failed"
              ? t("settings.marketplace.progressFailed")
              : t("settings.marketplace.progressTitle")}
        </span>
      }
      className="sm:max-w-sm"
      footer={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onOpenChange(false)}
          disabled={progress.phase === "starting" || progress.phase === "running"}
        >
          {t("common.close")}
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm font-medium truncate">{progress.skillName}</p>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          {progress.phase === "completed" ? (
            <div className="h-full w-full rounded-full bg-emerald-500 transition-all duration-500" />
          ) : progress.phase === "failed" ? (
            <div className="h-full w-full rounded-full bg-destructive transition-all duration-500" />
          ) : (
            <div className="h-full w-1/2 animate-progress-indeterminate rounded-full bg-primary" />
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {progress.phase === "starting" && t("settings.marketplace.progressStarting")}
          {progress.phase === "running" && t("settings.marketplace.progressRunning")}
          {progress.phase === "completed" && t("settings.marketplace.progressDone")}
          {progress.phase === "failed" && (
            <span className="text-destructive">{t("settings.marketplace.installFailed")}</span>
          )}
        </p>
        {progress.rawLines.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/70 hover:text-muted-foreground transition-colors"
            >
              {showDetails ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
              {t("settings.marketplace.progressDetails")}
            </button>
            {showDetails && (
              <div className="mt-2 max-h-40 overflow-auto rounded-md bg-muted/50 p-2.5 font-mono text-[10px] leading-relaxed text-muted-foreground break-all whitespace-pre-wrap">
                {progress.rawLines.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </BaseDialog>
  );
}
