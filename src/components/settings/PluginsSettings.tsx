import { BookOpen, Layers, Loader2, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useActions, useConnectionState } from "@/hooks/use-agent-state";
import { useDesktopShell } from "@/shell/provider";
import type { InstalledPluginInfo, PluginCatalogEntry } from "@/types/electron";

type PluginScope = "project" | "global";
type PluginOrigin = "published" | "custom";

type PluginListItem =
  | {
      kind: "group";
      name: string;
      scope: PluginScope;
      origin: PluginOrigin;
      capabilities: InstalledPluginInfo[];
    }
  | {
      kind: "general";
      name: string;
      scope: PluginScope;
      origin: PluginOrigin;
      capability: InstalledPluginInfo;
    };

export function PluginsTabContent() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<"installed" | "discover">("installed");

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b pb-2">
        <button
          type="button"
          className={`rounded-t px-2.5 py-1 text-xs font-medium transition-colors ${
            activeTab === "installed"
              ? "border-b-2 border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("installed")}
        >
          {t("settings.plugins.installed")}
        </button>
        <button
          type="button"
          className={`rounded-t px-2.5 py-1 text-xs font-medium transition-colors ${
            activeTab === "discover"
              ? "border-b-2 border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("discover")}
        >
          {t("settings.plugins.discover")}
        </button>
      </div>
      {activeTab === "installed" ? <InstalledPluginsView /> : <DiscoverPluginsView />}
    </div>
  );
}

function remoteKeyForPlugin(plugin: PluginCatalogEntry) {
  return `${plugin.source?.toLowerCase()}@${plugin.slug?.toLowerCase()}`;
}

function installSourceForPlugin(plugin: PluginCatalogEntry) {
  return plugin.source ? `${plugin.source}@${plugin.slug}` : plugin.id || plugin.slug;
}

function DiscoverPluginsView() {
  const { t } = useTranslation();
  const skillsApi = useDesktopShell().skills;
  const { activeDirectory } = useConnectionState();
  const { refreshProviders } = useActions();
  const scopedDirectory = activeDirectory ?? undefined;
  const [query, setQuery] = useState("");
  const [plugins, setPlugins] = useState<PluginCatalogEntry[]>([]);
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [globalScope, setGlobalScope] = useState(false);
  const [manualSource, setManualSource] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refreshInstalled = useCallback(async () => {
    setInstalledPlugins(await skillsApi.listInstalled(scopedDirectory).catch(() => []));
  }, [skillsApi, scopedDirectory]);

  const loadPlugins = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const trimmed = query.trim();
      const result = trimmed
        ? await skillsApi.marketplace.search(trimmed, 50)
        : await skillsApi.marketplace.list(undefined, 0, 50);
      setPlugins(result.data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
      setPlugins([]);
    } finally {
      setLoading(false);
    }
  }, [skillsApi, query]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadPlugins(), 250);
    return () => window.clearTimeout(timeout);
  }, [loadPlugins]);

  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  const installSource = useCallback(
    async (source: string, key: string) => {
      const trimmed = source.trim();
      if (!trimmed) return;
      setBusyKey(key);
      setError(null);
      try {
        await skillsApi.install(trimmed, scopedDirectory, globalScope);
        await refreshInstalled();
        await refreshProviders();
        setManualSource("");
      } catch (installError) {
        setError(installError instanceof Error ? installError.message : String(installError));
      } finally {
        setBusyKey(null);
      }
    },
    [skillsApi, scopedDirectory, globalScope, refreshInstalled, refreshProviders],
  );

  const installedRemoteKeys = useMemo(
    () => new Set(installedPlugins.map((plugin) => plugin.remoteKey).filter(Boolean)),
    [installedPlugins],
  );

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/20 p-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={manualSource}
            onChange={(event) => setManualSource(event.target.value)}
            placeholder={t("settings.plugins.installSourcePlaceholder")}
            className="h-9 flex-1"
          />
          <Button
            type="button"
            size="sm"
            disabled={!manualSource.trim() || busyKey === "manual"}
            onClick={() => void installSource(manualSource, "manual")}
          >
            {busyKey === "manual" ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
            {t("settings.plugins.install")}
          </Button>
        </div>
        <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={globalScope}
            onChange={(event) => setGlobalScope(event.target.checked)}
          />
          {t("settings.plugins.globalScope")}
        </label>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="h-10 pl-9 pr-8 text-sm"
          placeholder={t("settings.plugins.searchPlaceholder")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 p-3 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Spinner className="size-5" />
        </div>
      ) : plugins.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          {t("settings.plugins.noResults")}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {plugins.map((plugin) => {
            const source = installSourceForPlugin(plugin);
            const key = remoteKeyForPlugin(plugin);
            const installed = installedRemoteKeys.has(key);
            return (
              <div key={plugin.id} className="rounded-lg border bg-card p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-sm font-medium">{plugin.name}</h3>
                      {installed ? (
                        <Badge variant="secondary" className="text-[10px]">
                          {t("settings.plugins.installed")}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                      {plugin.source}/{plugin.slug}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={installed || busyKey === key}
                    onClick={() => void installSource(source, key)}
                  >
                    {busyKey === key ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
                    {installed ? t("settings.plugins.installed") : t("settings.plugins.install")}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function hasExternalSource(plugin: InstalledPluginInfo) {
  if (plugin.sourceType === "local") return false;
  return Boolean(plugin.source || plugin.sourceUrl || plugin.remoteKey);
}

function pluginOrigin(plugin: InstalledPluginInfo): PluginOrigin {
  return hasExternalSource(plugin) ? "published" : "custom";
}

function scopeLabel(scope: PluginScope, t: ReturnType<typeof useTranslation>["t"]) {
  return scope === "project" ? t("settings.plugins.project") : t("settings.plugins.global");
}

function originLabel(origin: PluginOrigin, t: ReturnType<typeof useTranslation>["t"]) {
  return origin === "published" ? t("settings.plugins.published") : t("settings.plugins.custom");
}

function buildPluginItems(skills: InstalledPluginInfo[], scope: PluginScope): PluginListItem[] {
  const scoped = skills.filter((skill) => skill.scope === scope);
  const groups = new Map<string, InstalledPluginInfo[]>();
  const general: InstalledPluginInfo[] = [];

  for (const skill of scoped) {
    if (skill.pluginName)
      groups.set(skill.pluginName, [...(groups.get(skill.pluginName) ?? []), skill]);
    else general.push(skill);
  }

  return [
    ...[...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, capabilities]) => ({
        kind: "group" as const,
        name,
        scope,
        origin: (capabilities.some(hasExternalSource) ? "published" : "custom") as PluginOrigin,
        capabilities: capabilities.sort((a, b) => a.name.localeCompare(b.name)),
      })),
    ...general
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((capability) => ({
        kind: "general" as const,
        name: capability.name,
        scope,
        origin: pluginOrigin(capability),
        capability,
      })),
  ];
}

function InstalledPluginsView() {
  const { t } = useTranslation();
  const skillsApi = useDesktopShell().skills;
  const { activeDirectory } = useConnectionState();
  const { refreshProviders } = useActions();
  const scopedDirectory = activeDirectory ?? undefined;

  const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());

  const refresh = useCallback(async () => {
    if (!skillsApi) return;
    setLoading(true);
    try {
      setInstalledPlugins(await skillsApi.listInstalled(scopedDirectory).catch(() => []));
    } finally {
      setLoading(false);
    }
  }, [skillsApi, scopedDirectory]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const projectItems = useMemo(
    () => buildPluginItems(installedPlugins, "project"),
    [installedPlugins],
  );
  const globalItems = useMemo(
    () => buildPluginItems(installedPlugins, "global"),
    [installedPlugins],
  );

  const handleRemoveOne = useCallback(
    async (plugin: InstalledPluginInfo) => {
      if (!skillsApi) return;
      await skillsApi
        .remove(plugin.name, scopedDirectory, plugin.scope === "global")
        .catch(() => undefined);
      await refresh();
      await refreshProviders();
    },
    [skillsApi, scopedDirectory, refresh, refreshProviders],
  );

  const handleUpdateOne = useCallback(
    async (plugin: InstalledPluginInfo) => {
      if (!skillsApi) return;
      await skillsApi
        .update(plugin.name, scopedDirectory, plugin.scope === "global")
        .catch(() => undefined);
      await refresh();
      await refreshProviders();
    },
    [skillsApi, scopedDirectory, refresh, refreshProviders],
  );

  const handleGroupAction = useCallback(
    async (plugins: InstalledPluginInfo[], action: "update" | "remove") => {
      if (!skillsApi) return;
      for (const plugin of plugins) {
        if (action === "update")
          await skillsApi.update(plugin.name, scopedDirectory, plugin.scope === "global");
        else await skillsApi.remove(plugin.name, scopedDirectory, plugin.scope === "global");
      }
      await refresh();
      await refreshProviders();
    },
    [skillsApi, scopedDirectory, refresh, refreshProviders],
  );

  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  if (loading)
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner className="size-5" />
      </div>
    );

  const hasAny = projectItems.length > 0 || globalItems.length > 0;

  return !hasAny ? (
    <div className="py-8 text-center text-sm text-muted-foreground">
      {t("settings.plugins.noPlugins")}
    </div>
  ) : (
    <div className="space-y-6">
      <PluginScopeSection
        scope="project"
        items={projectItems}
        expandedGroups={expandedGroups}
        onToggleGroup={toggleGroup}
        onUpdateOne={handleUpdateOne}
        onRemoveOne={handleRemoveOne}
        onGroupAction={handleGroupAction}
      />
      <PluginScopeSection
        scope="global"
        items={globalItems}
        expandedGroups={expandedGroups}
        onToggleGroup={toggleGroup}
        onUpdateOne={handleUpdateOne}
        onRemoveOne={handleRemoveOne}
        onGroupAction={handleGroupAction}
      />
    </div>
  );
}

function PluginScopeSection({
  scope,
  items,
  expandedGroups,
  onToggleGroup,
  onUpdateOne,
  onRemoveOne,
  onGroupAction,
}: {
  scope: PluginScope;
  items: PluginListItem[];
  expandedGroups: Set<string>;
  onToggleGroup: (key: string) => void;
  onUpdateOne: (plugin: InstalledPluginInfo) => void;
  onRemoveOne: (plugin: InstalledPluginInfo) => void;
  onGroupAction: (plugins: InstalledPluginInfo[], action: "update" | "remove") => void;
}) {
  const { t } = useTranslation();
  const groups = items.filter((item) => item.kind === "group");
  const general = items.filter((item) => item.kind === "general");

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{scopeLabel(scope, t)}</h3>
        <Badge variant="outline" className="text-[10px]">
          {items.length}
        </Badge>
      </div>
      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
          {t("settings.plugins.emptyScope")}
        </div>
      ) : (
        <div className="space-y-4">
          {groups.length > 0 && (
            <PluginSection title={t("settings.plugins.pluginGroups")}>
              {groups.map((item) => (
                <PluginGroupCard
                  key={`${scope}:group:${item.name}`}
                  item={item}
                  expanded={expandedGroups.has(`${scope}:group:${item.name}`)}
                  onToggle={() => onToggleGroup(`${scope}:group:${item.name}`)}
                  onUpdateOne={onUpdateOne}
                  onRemoveOne={onRemoveOne}
                  onGroupAction={onGroupAction}
                />
              ))}
            </PluginSection>
          )}
          {general.length > 0 && (
            <PluginSection title={t("settings.plugins.general")}>
              {general.map((item) => (
                <GeneralPluginCard
                  key={`${scope}:general:${item.capability.location}`}
                  item={item}
                  onUpdate={onUpdateOne}
                  onRemove={onRemoveOne}
                />
              ))}
            </PluginSection>
          )}
        </div>
      )}
    </section>
  );
}

function PluginSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function PluginBadges({ scope, origin }: { scope: PluginScope; origin: PluginOrigin }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1.5">
      <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
        {scopeLabel(scope, t)}
      </Badge>
      <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
        {originLabel(origin, t)}
      </Badge>
    </div>
  );
}

function PluginGroupCard({
  item,
  expanded,
  onToggle,
  onUpdateOne,
  onRemoveOne,
  onGroupAction,
}: {
  item: Extract<PluginListItem, { kind: "group" }>;
  expanded: boolean;
  onToggle: () => void;
  onUpdateOne: (plugin: InstalledPluginInfo) => void;
  onRemoveOne: (plugin: InstalledPluginInfo) => void;
  onGroupAction: (plugins: InstalledPluginInfo[], action: "update" | "remove") => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-start gap-3">
        <Layers className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onToggle}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{item.name}</span>
            <PluginBadges scope={item.scope} origin={item.origin} />
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("settings.plugins.capabilityCount", { count: item.capabilities.length })}
          </p>
        </button>
        <div className="flex shrink-0 gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => onGroupAction(item.capabilities, "update")}
          >
            {t("settings.plugins.updateGroup")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px] text-destructive hover:text-destructive"
            onClick={() => onGroupAction(item.capabilities, "remove")}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="mt-3 space-y-2 border-t pt-3">
          {item.capabilities.map((capability) => (
            <div
              key={capability.location}
              className="flex items-start gap-3 rounded-md bg-muted/40 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium">{capability.name}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{capability.description}</div>
                <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                  {capability.location}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => onUpdateOne(capability)}
                >
                  {t("settings.plugins.update")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[10px] text-destructive hover:text-destructive"
                  onClick={() => onRemoveOne(capability)}
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GeneralPluginCard({
  item,
  onUpdate,
  onRemove,
}: {
  item: Extract<PluginListItem, { kind: "general" }>;
  onUpdate: (plugin: InstalledPluginInfo) => void;
  onRemove: (plugin: InstalledPluginInfo) => void;
}) {
  const { t } = useTranslation();
  const plugin = item.capability;
  return (
    <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
      <BookOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{plugin.name}</span>
          <PluginBadges scope={item.scope} origin={item.origin} />
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{plugin.description}</p>
        <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
          {plugin.location}
        </p>
      </div>
      <div className="flex shrink-0 gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-[11px]"
          onClick={() => onUpdate(plugin)}
        >
          {t("settings.plugins.update")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-[11px] text-destructive hover:text-destructive"
          onClick={() => onRemove(plugin)}
        >
          <Trash2 className="size-3" />
        </Button>
      </div>
    </div>
  );
}
