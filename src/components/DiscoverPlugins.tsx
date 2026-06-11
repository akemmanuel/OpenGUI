import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Globe, Loader2, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePluginsPlatform } from "@/hooks/use-plugins-platform";
import { useConnectionState } from "@/hooks/use-agent-state";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  InstallFlowDialog,
  InstallProgressDialog,
  type InstallProgress,
  PluginCard,
  PluginDetailDialog,
  type PluginInstallState,
} from "@/components/PluginMarketplaceParts";
import { useDesktopShell } from "@/shell/provider";
import type {
  InstalledPluginInfo,
  PluginCatalogAuditResponse,
  PluginCatalogDetailResponse,
  PluginCatalogEntry,
} from "@/types/electron";

type InstallPhase = InstallProgress["phase"];

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

      <PluginDetailDialog
        plugin={selectedPlugin !== null && !showInstallFlow ? selectedPlugin : null}
        detailLoading={detailLoading}
        detailData={detailData}
        auditData={auditData}
        installState={selectedInstallState}
        busy={busyKeys.has(selectedBusyKey)}
        onClose={() => setSelectedPlugin(null)}
        onInstall={() => setShowInstallFlow(true)}
        onUpdate={handleUpdate}
        onRemove={handleRemove}
      />

      {/* Install flow dialog */}
      <InstallFlowDialog
        open={showInstallFlow}
        onOpenChange={setShowInstallFlow}
        plugin={installPlugin}
        directory={scopedDirectory}
        onConfirm={confirmInstall}
      />

      <InstallProgressDialog
        open={showProgress}
        onOpenChange={setShowProgress}
        progress={installProgress}
      />
    </div>
  );
}
