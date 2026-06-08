import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
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
  Search,
  ShieldCheck,
  Star,
  Terminal,
  Trash2,
  TrendingUp,
  X,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePluginsPlatform } from "@/hooks/use-plugins-platform";
import { useConnectionState } from "@/hooks/use-agent-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { BaseDialog } from "@/components/ui/base-dialog";
import { useDesktopShell } from "@/shell/provider";
import type {
  InstalledPluginInfo,
  PluginCatalogAuditResponse,
  PluginCatalogDetailResponse,
  PluginCatalogEntry,
} from "@/types/electron";

type PluginInstallState = {
  exact?: InstalledPluginInfo;
  conflict?: InstalledPluginInfo;
};

type InstallPhase = "starting" | "running" | "completed" | "failed";

type InstallProgress = {
  phase: InstallPhase;
  rawLines: string[];
  skillName: string;
};

function parseInstallPhase(line: string, current: InstallPhase): { phase: InstallPhase } | null {
  const lower = line.toLowerCase();

  // "Installed X skill" = success — takes priority, never downgrade after this
  if (
    lower.includes("installation complete") ||
    (lower.includes("installed") && lower.includes("skill"))
  ) {
    return { phase: "completed" };
  }

  // Partial failure ("Failed to install" for one format) should NOT override
  // a prior "completed" — the skill itself was installed.
  if (current !== "completed") {
    if (lower.includes("failed to install") || lower.includes("error:")) {
      return { phase: "failed" };
    }
    if (lower.includes("process exited with code") && !lower.includes("code 0")) {
      return { phase: "failed" };
    }
  }

  if (
    lower.includes("process exited with code 0") &&
    current !== "completed" &&
    current !== "failed"
  ) {
    return { phase: "completed" };
  }

  if (current === "starting") {
    return { phase: "running" };
  }
  return null;
}

function remoteKeyForPlugin(plugin: PluginCatalogEntry) {
  return `${plugin.source?.toLowerCase()}@${plugin.slug?.toLowerCase()}`;
}

interface PluginCardProps {
  plugin: PluginCatalogEntry;
  installState: PluginInstallState;
  busy: boolean;
  onInstall: (plugin: PluginCatalogEntry) => void;
  onUpdate: (installed: InstalledPluginInfo) => void;
  onRemove: (installed: InstalledPluginInfo) => void;
  onClick: (plugin: PluginCatalogEntry) => void;
}

function PluginCard({
  plugin,
  installState,
  busy,
  onInstall,
  onUpdate,
  onRemove,
  onClick,
}: PluginCardProps) {
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

interface InstallFlowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plugin: PluginCatalogEntry | null;
  directory: string | undefined;
  onConfirm: (source: string, globalScope: boolean) => void;
}

function InstallFlowDialog({
  open,
  onOpenChange,
  plugin,
  directory,
  onConfirm,
}: InstallFlowDialogProps) {
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

export function DiscoverPlugins() {
  const { t } = useTranslation();
  const pluginsApi = usePluginsPlatform();
  const catalogApi = pluginsApi?.marketplace;
  const { activeDirectory } = useConnectionState();
  const shell = useDesktopShell();

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [plugins, setPlugins] = useState<PluginCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginInfo[]>([]);
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  const [selectedPlugin, setSelectedPlugin] = useState<PluginCatalogEntry | null>(null);
  const [detailData, setDetailData] = useState<PluginCatalogDetailResponse | null>(null);
  const [auditData, setAuditData] = useState<PluginCatalogAuditResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showInstallFlow, setShowInstallFlow] = useState(false);
  const [installPlugin, setInstallPlugin] = useState<PluginCatalogEntry | null>(null);
  const [showProgress, setShowProgress] = useState(false);
  const [installProgress, setInstallProgress] = useState<InstallProgress>({
    phase: "starting",
    rawLines: [],
    skillName: "",
  });
  const [showDetails, setShowDetails] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const scopedDirectory = activeDirectory ?? undefined;

  // Listen for install progress events
  useEffect(() => {
    const unsub = shell.skills.onInstallProgress((data: { chunk: string; type: string }) => {
      const line = `[${data.type}] ${data.chunk}`;
      setInstallProgress((prev) => {
        const parsed = parseInstallPhase(line, prev.phase);
        return {
          ...prev,
          phase: parsed?.phase ?? prev.phase,
          rawLines: [...prev.rawLines, line],
        };
      });
    });
    return unsub;
  }, [shell]);

  // Debounce search
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => setDebouncedQuery(query), 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [query]);

  // Fetch plugins
  const fetchPlugins = useCallback(async () => {
    if (!catalogApi) return;
    setLoading(true);
    try {
      if (debouncedQuery) {
        if (debouncedQuery.length < 2) {
          setPlugins([]);
          return;
        }
        const res = await catalogApi.search(debouncedQuery, 50);
        setPlugins(res.data);
      } else {
        const res = await catalogApi.list(undefined, 0, 50);
        setPlugins(res.data);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load plugins");
    } finally {
      setLoading(false);
    }
  }, [catalogApi, debouncedQuery]);

  // Fetch installed plugins
  const fetchInstalled = useCallback(async () => {
    if (!pluginsApi) return;
    try {
      const installed: InstalledPluginInfo[] = await pluginsApi.listInstalled(scopedDirectory);
      setInstalledPlugins(installed);
    } catch {}
  }, [pluginsApi, scopedDirectory]);

  // Initial load
  useEffect(() => {
    void fetchPlugins();
  }, [debouncedQuery]);

  useEffect(() => {
    void fetchInstalled();
  }, [fetchInstalled]);

  // Open detail
  const openDetail = useCallback(
    async (plugin: PluginCatalogEntry) => {
      setSelectedPlugin(plugin);
      setDetailLoading(true);
      setDetailData(null);
      setAuditData(null);
      if (catalogApi) {
        try {
          const [detail, audit] = await Promise.all([
            catalogApi.detail(plugin.source, plugin.slug),
            catalogApi.audit(plugin.source, plugin.slug).catch(() => null),
          ]);
          setDetailData(detail);
          setAuditData(audit);
        } catch {}
      }
      setDetailLoading(false);
    },
    [catalogApi],
  );

  const getInstallState = useCallback(
    (plugin: PluginCatalogEntry): PluginInstallState => {
      const remoteKey = remoteKeyForPlugin(plugin);
      const exact = installedPlugins.find((installed) => installed.remoteKey === remoteKey);
      if (exact) return { exact };
      const slug = plugin.slug?.toLowerCase();
      const name = plugin.name?.toLowerCase();
      const conflict = installedPlugins.find(
        (installed) =>
          installed.name?.toLowerCase() === name || installed.slug?.toLowerCase() === slug,
      );
      return { conflict };
    },
    [installedPlugins],
  );

  const runPluginAction = useCallback(
    async (key: string, action: () => Promise<void>, skillName?: string) => {
      setBusyKeys((prev) => new Set(prev).add(key));
      setInstallProgress({
        phase: "starting",
        rawLines: [],
        skillName: skillName || key,
      });
      setShowDetails(false);
      setShowProgress(true);
      try {
        await action();
        await fetchInstalled();
      } catch {}
      setBusyKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    },
    [fetchInstalled],
  );

  // Install
  const handleInstall = useCallback((plugin: PluginCatalogEntry) => {
    setInstallPlugin(plugin);
    setShowInstallFlow(true);
  }, []);

  const handleUpdate = useCallback(
    async (installed: InstalledPluginInfo) => {
      if (!pluginsApi) return;
      const key = installed.remoteKey || installed.location;
      await runPluginAction(key, async () => {
        await pluginsApi.update(installed.name, scopedDirectory, installed.scope === "global");
      });
    },
    [pluginsApi, scopedDirectory, runPluginAction],
  );

  const handleRemove = useCallback(
    async (installed: InstalledPluginInfo) => {
      if (!pluginsApi) return;
      const key = installed.remoteKey || installed.location;
      await runPluginAction(key, async () => {
        await pluginsApi.remove(installed.name, scopedDirectory, installed.scope === "global");
      });
    },
    [pluginsApi, scopedDirectory, runPluginAction],
  );

  const confirmInstall = useCallback(
    async (source: string, globalScope: boolean) => {
      if (!pluginsApi || !installPlugin) return;
      const key = remoteKeyForPlugin(installPlugin);
      await runPluginAction(
        key,
        async () => {
          await pluginsApi.install(source, scopedDirectory, globalScope);
        },
        installPlugin.name,
      );
    },
    [pluginsApi, scopedDirectory, runPluginAction, installPlugin],
  );

  const selectedInstallState = selectedPlugin ? getInstallState(selectedPlugin) : {};
  const selectedBusyKey =
    selectedInstallState.exact?.remoteKey ||
    (selectedPlugin ? remoteKeyForPlugin(selectedPlugin) : "");

  if (!catalogApi) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-sm text-muted-foreground">{t("settings.skills.cliUnavailable")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Search bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="h-10 pl-9 pr-8 text-sm"
          placeholder={t("settings.marketplace.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {/* Plugin cards grid */}
      {loading && plugins.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            <span className="text-xs">{t("settings.marketplace.loading")}</span>
          </div>
        </div>
      ) : plugins.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <Globe className="size-8 opacity-30" />
            <span className="text-sm">{t("settings.marketplace.noResults")}</span>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {plugins.map((plugin) => {
              const installState = getInstallState(plugin);
              const busyKey = installState.exact?.remoteKey || remoteKeyForPlugin(plugin);
              return (
                <PluginCard
                  key={plugin.id}
                  plugin={plugin}
                  installState={installState}
                  busy={busyKeys.has(busyKey)}
                  onInstall={handleInstall}
                  onUpdate={handleUpdate}
                  onRemove={handleRemove}
                  onClick={openDetail}
                />
              );
            })}
          </div>

          {loading && plugins.length > 0 && (
            <div className="flex justify-center py-4">
              <Spinner className="size-5" />
            </div>
          )}
        </>
      )}

      {/* Detail dialog */}
      <BaseDialog
        open={selectedPlugin !== null && !showInstallFlow}
        onOpenChange={(open) => {
          if (!open) setSelectedPlugin(null);
        }}
        title={selectedPlugin?.name || ""}
        description={selectedPlugin ? `${selectedPlugin.source}/${selectedPlugin.slug}` : ""}
        className="sm:max-w-2xl max-h-[80vh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden pr-3"
        headerClassName="border-b pb-4 pr-8"
        bodyClassName="overflow-y-auto pr-3"
        footerClassName="border-t bg-background pt-4"
        footer={
          selectedPlugin && (
            <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Star className="size-3" />
                {selectedPlugin.installs.toLocaleString()} {t("settings.marketplace.installsLabel")}
                {selectedPlugin.installUrl && (
                  <a
                    href={selectedPlugin.installUrl}
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
                {selectedInstallState.exact ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busyKeys.has(selectedBusyKey)}
                      onClick={() => handleUpdate(selectedInstallState.exact!)}
                    >
                      <RefreshCw className="size-3.5 mr-1" />
                      {t("settings.skills.update")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      disabled={busyKeys.has(selectedBusyKey)}
                      onClick={() => handleRemove(selectedInstallState.exact!)}
                    >
                      <Trash2 className="size-3.5 mr-1" />
                      {t("settings.skills.remove")}
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant={selectedInstallState.conflict ? "outline" : "default"}
                    disabled={busyKeys.has(selectedBusyKey)}
                    onClick={() => {
                      setShowInstallFlow(true);
                    }}
                  >
                    {busyKeys.has(selectedBusyKey) ? (
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
            {/* Plugin capability content */}
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

            {/* Audit results */}
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

      {/* Install flow dialog */}
      <InstallFlowDialog
        open={showInstallFlow}
        onOpenChange={setShowInstallFlow}
        plugin={installPlugin}
        directory={scopedDirectory}
        onConfirm={confirmInstall}
      />

      {/* Progress dialog */}
      <BaseDialog
        open={showProgress}
        onOpenChange={setShowProgress}
        title={
          <span className="inline-flex items-center gap-2">
            {installProgress.phase === "completed" ? (
              <CheckCircle2 className="size-4 text-emerald-500" />
            ) : installProgress.phase === "failed" ? (
              <XCircle className="size-4 text-destructive" />
            ) : (
              <PackagePlus className="size-4" />
            )}
            {installProgress.phase === "completed"
              ? t("settings.marketplace.progressComplete")
              : installProgress.phase === "failed"
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
            onClick={() => setShowProgress(false)}
            disabled={installProgress.phase === "starting" || installProgress.phase === "running"}
          >
            {t("common.close")}
          </Button>
        }
      >
        <div className="space-y-4">
          {/* Skill name */}
          <p className="text-sm font-medium truncate">{installProgress.skillName}</p>

          {/* Progress bar */}
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            {installProgress.phase === "completed" ? (
              <div className="h-full w-full rounded-full bg-emerald-500 transition-all duration-500" />
            ) : installProgress.phase === "failed" ? (
              <div className="h-full w-full rounded-full bg-destructive transition-all duration-500" />
            ) : (
              <div className="h-full w-1/2 animate-progress-indeterminate rounded-full bg-primary" />
            )}
          </div>

          {/* Status message */}
          <p className="text-xs text-muted-foreground">
            {installProgress.phase === "starting" && t("settings.marketplace.progressStarting")}
            {installProgress.phase === "running" && t("settings.marketplace.progressRunning")}
            {installProgress.phase === "completed" && t("settings.marketplace.progressDone")}
            {installProgress.phase === "failed" && (
              <span className="text-destructive">{t("settings.marketplace.installFailed")}</span>
            )}
          </p>

          {/* Collapsible details */}
          {installProgress.rawLines.length > 0 && (
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
                  {installProgress.rawLines.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </BaseDialog>
    </div>
  );
}
