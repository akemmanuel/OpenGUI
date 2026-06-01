import { BookOpen, Layers, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SkillsMarketplace } from "@/components/SkillsMarketplace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useConnectionState } from "@/hooks/use-agent-state";
import { useSkillsPlatform } from "@/hooks/use-skills-platform";
import type { InstalledSkillInfo } from "@/types/electron";

type PluginScope = "project" | "global";
type PluginOrigin = "published" | "custom";

type PluginListItem =
  | {
      kind: "group";
      name: string;
      scope: PluginScope;
      origin: PluginOrigin;
      capabilities: InstalledSkillInfo[];
    }
  | {
      kind: "general";
      name: string;
      scope: PluginScope;
      origin: PluginOrigin;
      capability: InstalledSkillInfo;
    };

export function PluginsTabContent() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<"installed" | "discover">("installed");

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b pb-2">
        <button
          type="button"
          className={`text-xs font-medium px-2.5 py-1 rounded-t transition-colors ${
            activeTab === "installed"
              ? "text-foreground border-b-2 border-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("installed")}
        >
          {t("settings.plugins.installed")}
        </button>
        <button
          type="button"
          className={`text-xs font-medium px-2.5 py-1 rounded-t transition-colors ${
            activeTab === "discover"
              ? "text-foreground border-b-2 border-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("discover")}
        >
          {t("settings.plugins.discover")}
        </button>
      </div>
      {activeTab === "installed" ? <InstalledPluginsView /> : <SkillsMarketplace />}
    </div>
  );
}

function hasExternalSource(plugin: InstalledSkillInfo) {
  if (plugin.sourceType === "local") return false;
  return Boolean(plugin.source || plugin.sourceUrl || plugin.remoteKey);
}

function pluginOrigin(plugin: InstalledSkillInfo): PluginOrigin {
  return hasExternalSource(plugin) ? "published" : "custom";
}

function scopeLabel(scope: PluginScope, t: ReturnType<typeof useTranslation>["t"]) {
  return scope === "project" ? t("settings.plugins.project") : t("settings.plugins.global");
}

function originLabel(origin: PluginOrigin, t: ReturnType<typeof useTranslation>["t"]) {
  return origin === "published" ? t("settings.plugins.published") : t("settings.plugins.custom");
}

function buildPluginItems(skills: InstalledSkillInfo[], scope: PluginScope): PluginListItem[] {
  const scoped = skills.filter((skill) => skill.scope === scope);
  const groups = new Map<string, InstalledSkillInfo[]>();
  const general: InstalledSkillInfo[] = [];

  for (const skill of scoped) {
    if (skill.pluginName) {
      const existing = groups.get(skill.pluginName) ?? [];
      existing.push(skill);
      groups.set(skill.pluginName, existing);
    } else {
      general.push(skill);
    }
  }

  const groupedItems: PluginListItem[] = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, capabilities]) => ({
      kind: "group" as const,
      name,
      scope,
      origin: capabilities.some(hasExternalSource) ? "published" : "custom",
      capabilities: capabilities.sort((a, b) => a.name.localeCompare(b.name)),
    }));

  const generalItems: PluginListItem[] = general
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((capability) => ({
      kind: "general" as const,
      name: capability.name,
      scope,
      origin: pluginOrigin(capability),
      capability,
    }));

  return [...groupedItems, ...generalItems];
}

function InstalledPluginsView() {
  const { t } = useTranslation();
  const skillsApi = useSkillsPlatform();
  const { activeDirectory } = useConnectionState();
  const scopedDirectory = activeDirectory ?? undefined;

  const [installedPlugins, setInstalledPlugins] = useState<InstalledSkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());

  const refresh = useCallback(async () => {
    if (!skillsApi) {
      setInstalledPlugins([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const installed = await skillsApi.listInstalled(scopedDirectory).catch(() => []);
      setInstalledPlugins(installed);
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
    async (plugin: InstalledSkillInfo) => {
      if (!skillsApi) return;
      try {
        await skillsApi.remove(plugin.name, scopedDirectory, plugin.scope === "global");
        await refresh();
      } catch {}
    },
    [skillsApi, scopedDirectory, refresh],
  );

  const handleUpdateOne = useCallback(
    async (plugin: InstalledSkillInfo) => {
      if (!skillsApi) return;
      try {
        await skillsApi.update(plugin.name, scopedDirectory, plugin.scope === "global");
        await refresh();
      } catch {}
    },
    [skillsApi, scopedDirectory, refresh],
  );

  const handleGroupAction = useCallback(
    async (plugins: InstalledSkillInfo[], action: "update" | "remove") => {
      if (!skillsApi) return;
      try {
        for (const plugin of plugins) {
          if (action === "update") {
            await skillsApi.update(plugin.name, scopedDirectory, plugin.scope === "global");
          } else {
            await skillsApi.remove(plugin.name, scopedDirectory, plugin.scope === "global");
          }
        }
        await refresh();
      } catch {}
    },
    [skillsApi, scopedDirectory, refresh],
  );

  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner className="size-5" />
      </div>
    );
  }

  const hasAny = projectItems.length > 0 || globalItems.length > 0;

  return (
    <div className="space-y-6">
      {!hasAny ? (
        <div className="text-center py-8 text-sm text-muted-foreground">
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
      )}
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
  onUpdateOne: (plugin: InstalledSkillInfo) => void;
  onRemoveOne: (plugin: InstalledSkillInfo) => void;
  onGroupAction: (plugins: InstalledSkillInfo[], action: "update" | "remove") => void;
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
      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
        {scopeLabel(scope, t)}
      </Badge>
      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
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
  onUpdateOne: (plugin: InstalledSkillInfo) => void;
  onRemoveOne: (plugin: InstalledSkillInfo) => void;
  onGroupAction: (plugins: InstalledSkillInfo[], action: "update" | "remove") => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="rounded-lg border p-3 bg-card">
      <div className="flex items-start gap-3">
        <Layers className="size-4 text-muted-foreground shrink-0 mt-0.5" />
        <button type="button" className="flex-1 min-w-0 text-left" onClick={onToggle}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{item.name}</span>
            <PluginBadges scope={item.scope} origin={item.origin} />
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
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
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium">{capability.name}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{capability.description}</div>
                <div className="text-[10px] text-muted-foreground font-mono truncate mt-1">
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
                  {t("settings.skills.update")}
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
  onUpdate: (plugin: InstalledSkillInfo) => void;
  onRemove: (plugin: InstalledSkillInfo) => void;
}) {
  const { t } = useTranslation();
  const plugin = item.capability;

  return (
    <div className="flex items-start gap-3 rounded-lg border p-3 bg-card">
      <BookOpen className="size-4 text-muted-foreground shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{plugin.name}</span>
          <PluginBadges scope={item.scope} origin={item.origin} />
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{plugin.description}</p>
        <p className="text-[10px] text-muted-foreground font-mono truncate mt-1">
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
          {t("settings.skills.update")}
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
