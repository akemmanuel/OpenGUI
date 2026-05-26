/**
 * Server connection settings.
 * Sidebar entry opens settings view in main content area.
 */

import {
  AlertCircle,
  ArrowLeft,
  Bell,
  BookOpen,
  CheckCircle2,
  Folder,
  FolderOpen,
  Globe,
  Layers,
  RotateCcw,
  Settings,
  ShoppingBag,
  Terminal,
  Trash2,
} from "lucide-react";
import type { McpStatus } from "@opencode-ai/sdk/v2/client";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AGENT_BACKEND_LABELS, type AgentBackendId } from "@/agents";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { AppearanceSetting } from "@/components/AppearanceSetting";
import { SettingsProviders } from "@/components/SettingsProviders";
import { SkillsMarketplace } from "@/components/SkillsMarketplace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NOTIFICATIONS_ENABLED_KEY, useActions, useConnectionState } from "@/hooks/use-agent-state";
import {
  useAgentBackend,
  useAvailableBackendIds,
  useCurrentAgentBackendId,
} from "@/hooks/use-agent-backend";
import { DEFAULT_MODEL_MAX_AGE_MONTHS, STORAGE_KEYS } from "@/lib/constants";
import { storageGet, storageRemove, storageSet } from "@/lib/safe-storage";
import { detectSystemLanguage } from "@/i18n";
import { useSkillsPlatform } from "@/hooks/use-skills-platform";
import type { InstalledSkillInfo } from "@/types/electron";
import packageJson from "../../package.json";

// ---------------------------------------------------------------------------
// Compact footer badge (always visible in sidebar)
// ---------------------------------------------------------------------------

export function ConnectionPanel({
  onOpenSettings,
  isActive = false,
}: {
  onOpenSettings: () => void;
  isActive?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <SidebarMenu className="group-data-[collapsible=icon]:p-0">
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip={t("common.settings")}
          isActive={isActive}
          onClick={onOpenSettings}
        >
          <Settings />
          <span>{t("common.settings")}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function SettingsView({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-6">
        <div className="space-y-3">
          <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={onBack}>
            <ArrowLeft className="size-4" />
            {t("common.back")}
          </Button>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{t("common.settings")}</h1>
            <p className="text-sm text-muted-foreground">{t("settings.subtitle")}</p>
          </div>
        </div>
        <Tabs defaultValue="general" className="gap-4">
          <TabsList className="w-full">
            <TabsTrigger value="general" className="flex-1">
              {t("settings.tabs.general")}
            </TabsTrigger>
            <TabsTrigger value="providers" className="flex-1">
              {t("settings.tabs.providers")}
            </TabsTrigger>
            <TabsTrigger value="plugins" className="flex-1">
              <ShoppingBag className="size-3.5 mr-1.5" />
              {t("settings.tabs.plugins")}
            </TabsTrigger>
            <TabsTrigger value="mcp" className="flex-1">
              {t("settings.tabs.tools")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="general" className="mt-0 rounded-lg border p-4">
            <GeneralSettings />
          </TabsContent>
          <TabsContent value="providers" className="mt-0 rounded-lg border p-4">
            <SettingsProviders />
          </TabsContent>
          <TabsContent value="plugins" className="mt-0 rounded-lg border p-4">
            <PluginsTabContent />
          </TabsContent>
          <TabsContent value="mcp" className="mt-0 rounded-lg border p-4">
            <McpTabContent />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// General settings (wraps all general tab items)
// ---------------------------------------------------------------------------

function GeneralSettings() {
  const { t } = useTranslation();
  const { restartAgentBackends } = useActions();
  const [restarting, setRestarting] = useState(false);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try {
      await restartAgentBackends();
    } catch (error) {
      console.error("Failed to restart agent backends", error);
    } finally {
      setRestarting(false);
    }
  }, [restartAgentBackends]);

  return (
    <div className="flex flex-col gap-4">
      <AppearanceSetting />
      <LanguageSetting />
      <DefaultChatDirectorySetting />
      <FileManagerSetting />
      <TerminalSetting />
      <ModelAgeFilterSetting />
      <NotificationsToggle />
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="outline" size="sm" className="mt-2" disabled={restarting}>
            {restarting ? (
              <Spinner className="size-3.5 mr-2" />
            ) : (
              <RotateCcw className="size-3.5 mr-2" />
            )}
            {t("settings.general.restartServer")}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.general.restartServerTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.general.restartServerDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRestart}>{t("common.restart")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div className="flex items-center justify-between gap-3 pt-3 border-t">
        <span className="text-xs text-muted-foreground">{t("common.version")}</span>
        <span className="text-xs text-muted-foreground font-mono">{packageJson.version}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared storage-input setting
// ---------------------------------------------------------------------------

import type { LucideIcon } from "lucide-react";

function StorageInputSetting({
  storageKey,
  id,
  icon: Icon,
  label,
  placeholder,
  helpText,
  inputType,
  onChangeExtra,
}: {
  storageKey: string;
  id: string;
  icon: LucideIcon;
  label: string;
  placeholder: string;
  helpText: string;
  inputType?: string;
  onChangeExtra?: () => void;
}) {
  const [value, setValue] = useState(() => storageGet(storageKey) ?? "");

  const handleChange = (newValue: string) => {
    setValue(newValue);
    if (newValue.trim()) {
      storageSet(storageKey, newValue.trim());
    } else {
      storageRemove(storageKey);
    }
    onChangeExtra?.();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" />
        <Label htmlFor={id} className="text-sm font-normal">
          {label}
        </Label>
      </div>
      <Input
        id={id}
        type={inputType}
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder}
        className="font-mono text-sm"
      />
      <p className="text-[11px] text-muted-foreground">{helpText}</p>
    </div>
  );
}

function LanguageSetting() {
  const { t, i18n } = useTranslation();
  const [language, setLanguage] = useState<"auto" | "de" | "en" | "es">(() => {
    const storedLanguage = storageGet(STORAGE_KEYS.LANGUAGE);
    if (storedLanguage === "de" || storedLanguage === "en" || storedLanguage === "es") {
      return storedLanguage;
    }
    return "auto";
  });

  useEffect(() => {
    const storedLanguage = storageGet(STORAGE_KEYS.LANGUAGE);
    if (storedLanguage === "de" || storedLanguage === "en" || storedLanguage === "es") {
      setLanguage(storedLanguage);
      return;
    }
    setLanguage("auto");
  }, [i18n.resolvedLanguage]);

  const handleChange = (value: string) => {
    if (value === "auto") {
      setLanguage("auto");
      storageRemove(STORAGE_KEYS.LANGUAGE);
      void detectSystemLanguage().then((detected) => i18n.changeLanguage(detected));
      return;
    }
    if (value !== "de" && value !== "en" && value !== "es") return;
    setLanguage(value);
    storageSet(STORAGE_KEYS.LANGUAGE, value);
    void i18n.changeLanguage(value);
  };

  return (
    <div className="flex items-center justify-between gap-3 pt-3 border-t">
      <div className="flex items-center gap-2">
        <Globe className="size-4 text-muted-foreground" />
        <Label className="text-sm font-normal">{t("settings.general.language")}</Label>
      </div>
      <Select value={language} onValueChange={handleChange}>
        <SelectTrigger className="w-[180px] h-8">
          <SelectValue placeholder={t("settings.general.language")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">{t("common.autoDetect")}</SelectItem>
          <SelectItem value="de">{t("languages.de")}</SelectItem>
          <SelectItem value="en">{t("languages.en")}</SelectItem>
          <SelectItem value="es">{t("languages.es")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model age filter setting
// ---------------------------------------------------------------------------

function ModelAgeFilterSetting() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(() => {
    const raw = storageGet(STORAGE_KEYS.MODEL_MAX_AGE_MONTHS);
    if (raw === null) return true;
    const parsed = Number(raw);
    return !Number.isFinite(parsed) || parsed > 0;
  });
  const [months, setMonths] = useState(() => {
    const raw = storageGet(STORAGE_KEYS.MODEL_MAX_AGE_MONTHS);
    if (raw === null) return String(DEFAULT_MODEL_MAX_AGE_MONTHS);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return String(DEFAULT_MODEL_MAX_AGE_MONTHS);
    }
    return String(Math.round(parsed));
  });

  const broadcastChange = () => {
    window.dispatchEvent(new Event("model-max-age-months-changed"));
  };

  const persistMonths = (value: string) => {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      storageSet(STORAGE_KEYS.MODEL_MAX_AGE_MONTHS, String(Math.round(parsed)));
    } else {
      storageSet(STORAGE_KEYS.MODEL_MAX_AGE_MONTHS, String(DEFAULT_MODEL_MAX_AGE_MONTHS));
    }
    broadcastChange();
  };

  const handleToggle = (checked: boolean) => {
    setEnabled(checked);
    if (!checked) {
      storageSet(STORAGE_KEYS.MODEL_MAX_AGE_MONTHS, "0");
      broadcastChange();
      return;
    }
    persistMonths(months);
  };

  const handleMonthsChange = (value: string) => {
    const digitsOnly = value.replace(/[^0-9]/g, "");
    setMonths(digitsOnly);
    if (!enabled) return;
    persistMonths(digitsOnly);
  };

  const handleMonthsBlur = () => {
    if (months) return;
    const fallback = String(DEFAULT_MODEL_MAX_AGE_MONTHS);
    setMonths(fallback);
    if (enabled) persistMonths(fallback);
  };

  return (
    <div className="space-y-2 pt-3 border-t">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Layers className="size-4 text-muted-foreground" />
          <Label htmlFor="model-age-filter-toggle" className="text-sm font-normal">
            {t("settings.general.hideOldModels")}
          </Label>
        </div>
        <Switch
          id="model-age-filter-toggle"
          size="sm"
          checked={enabled}
          onCheckedChange={handleToggle}
        />
      </div>
      <div className="flex items-center gap-2">
        <Input
          id="model-age-filter-months"
          type="number"
          min="1"
          step="1"
          value={months}
          onChange={(e) => handleMonthsChange(e.target.value)}
          onBlur={handleMonthsBlur}
          disabled={!enabled}
          className="font-mono text-sm w-24"
        />
        <Label htmlFor="model-age-filter-months" className="text-sm text-muted-foreground">
          {t("settings.general.months")}
        </Label>
      </div>
      <p className="text-[11px] text-muted-foreground">{t("settings.general.hideOldModelsHelp")}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notifications toggle
// ---------------------------------------------------------------------------

function NotificationsToggle() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(() => {
    const raw = storageGet(NOTIFICATIONS_ENABLED_KEY);
    return raw === null || raw === "true";
  });

  const handleToggle = async (checked: boolean) => {
    if (checked && typeof Notification !== "undefined" && Notification.permission === "default") {
      const result = await Notification.requestPermission();
      if (result === "denied") return;
    }
    setEnabled(checked);
    storageSet(NOTIFICATIONS_ENABLED_KEY, String(checked));
  };

  const permissionDenied =
    typeof Notification !== "undefined" && Notification.permission === "denied";

  return (
    <div className="flex items-center justify-between gap-3 pt-3 border-t">
      <div className="flex items-center gap-2">
        <Bell className="size-4 text-muted-foreground" />
        <Label htmlFor="notifications-toggle" className="text-sm font-normal">
          {t("settings.general.desktopNotifications")}
        </Label>
      </div>
      {permissionDenied ? (
        <span className="text-xs text-muted-foreground">
          {t("settings.general.blockedByBrowser")}
        </span>
      ) : (
        <Switch
          id="notifications-toggle"
          size="sm"
          checked={enabled}
          onCheckedChange={handleToggle}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// File manager setting
// ---------------------------------------------------------------------------

function FileManagerSetting() {
  const { t } = useTranslation();

  return (
    <StorageInputSetting
      storageKey={STORAGE_KEYS.FILE_MANAGER}
      id="file-manager"
      icon={Folder}
      label={t("settings.general.fileManager")}
      placeholder={t("common.autoDetect")}
      helpText={t("settings.general.fileManagerHelp")}
    />
  );
}

// ---------------------------------------------------------------------------
// Terminal setting
// ---------------------------------------------------------------------------

function TerminalSetting() {
  const { t } = useTranslation();

  return (
    <StorageInputSetting
      storageKey={STORAGE_KEYS.TERMINAL}
      id="terminal"
      icon={Terminal}
      label={t("settings.general.terminal")}
      placeholder={t("common.autoDetect")}
      helpText={t("settings.general.terminalHelp")}
    />
  );
}

function DefaultChatDirectorySetting() {
  const { t } = useTranslation();
  const { setDefaultChatDirectory, openDirectory } = useActions();
  const { defaultChatDirectory, isLocalWorkspace } = useConnectionState();
  const [value, setValue] = useState(defaultChatDirectory ?? "");

  useEffect(() => {
    setValue(defaultChatDirectory ?? "");
  }, [defaultChatDirectory]);

  return (
    <div className="space-y-2 pt-3 border-t">
      <div className="flex items-center justify-between gap-2">
        <div className="space-y-1">
          <Label htmlFor="default-chat-directory" className="text-sm font-normal">
            {t("settings.general.defaultChatDirectory")}
          </Label>
          <p className="text-[11px] text-muted-foreground">
            {t("settings.general.defaultChatDirectoryHelp")}
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        <Input
          id="default-chat-directory"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => setDefaultChatDirectory(value.trim() || null)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              setDefaultChatDirectory(value.trim() || null);
            }
          }}
          placeholder="/absolute/path/to/chats"
          className="font-mono text-sm"
        />
        {isLocalWorkspace && (
          <Button
            type="button"
            variant="outline"
            onClick={async () => {
              const nextDirectory = await openDirectory();
              if (!nextDirectory) return;
              setValue(nextDirectory);
              setDefaultChatDirectory(nextDirectory);
            }}
          >
            <FolderOpen className="size-4" />
            {t("common.browse")}
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plugins tab content (inline)
// ---------------------------------------------------------------------------

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

function PluginsTabContent() {
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

// ---------------------------------------------------------------------------
// MCP/Tools tab content (inline)
// ---------------------------------------------------------------------------

function McpTabContent() {
  const initialBackendId = useCurrentAgentBackendId();
  const availableBackendIds = useAvailableBackendIds();
  const [backendId, setBackendId] = useState<AgentBackendId>(initialBackendId);
  const backend = useAgentBackend(backendId);
  const mcpApi = backend?.platform?.mcp;
  const configApi = backend?.platform?.config;
  const { activeDirectory, activeWorkspaceId } = useConnectionState();
  const scopedDirectory = activeDirectory ?? undefined;

  const [mcpStatus, setMcpStatus] = useState<{ [key: string]: McpStatus }>({});
  const [mcpTypes, setMcpTypes] = useState<{
    [key: string]: "local" | "remote";
  }>({});
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!mcpApi || !configApi) return;
    const target = { directory: scopedDirectory, workspaceId: activeWorkspaceId };
    const [statusData, configData] = await Promise.all([
      mcpApi.status(target),
      configApi.get(target),
    ]);
    setMcpStatus(statusData);
    if (configData?.mcp) {
      const types: { [key: string]: "local" | "remote" } = {};
      for (const [name, cfg] of Object.entries(configData.mcp)) {
        if (cfg && typeof cfg === "object" && "type" in cfg) {
          types[name] = (cfg as { type: "local" | "remote" }).type;
        }
      }
      setMcpTypes(types);
    }
    setLoading(false);
  }, [mcpApi, configApi, scopedDirectory, activeWorkspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleToggle = async (name: string, currentStatus: McpStatus) => {
    if (!mcpApi) return;
    setToggling(name);
    try {
      if (currentStatus.status === "connected") {
        await mcpApi.disconnect(
          { directory: scopedDirectory, workspaceId: activeWorkspaceId },
          name,
        );
      } else {
        await mcpApi.connect({ directory: scopedDirectory, workspaceId: activeWorkspaceId }, name);
      }
      await new Promise((r) => setTimeout(r, 500));
      await refresh();
    } finally {
      setToggling(null);
    }
  };

  const STATUS_CONFIG = {
    connected: {
      variant: "default" as const,
      label: "Connected",
      icon: CheckCircle2,
      className: "bg-emerald-600 hover:bg-emerald-600",
    },
    disabled: { variant: "secondary" as const, label: "Disabled" },
    failed: {
      variant: "destructive" as const,
      label: "Failed",
      icon: AlertCircle,
    },
    needs_auth: {
      variant: "outline" as const,
      label: "Needs auth",
      className: "text-amber-500 border-amber-500",
    },
    needs_client_registration: {
      variant: "outline" as const,
      label: "Needs registration",
      className: "text-amber-500 border-amber-500",
    },
  } as const;

  const entries = Object.entries(mcpStatus).sort(([a], [b]) => a.localeCompare(b));

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner className="size-5" />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {availableBackendIds.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {availableBackendIds.map((id) => (
            <Button
              key={id}
              type="button"
              variant={backendId === id ? "default" : "outline"}
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => setBackendId(id)}
            >
              {AGENT_BACKEND_LABELS[id]}
            </Button>
          ))}
        </div>
      )}
      {entries.length === 0 ? (
        <div className="text-center py-6 text-sm text-muted-foreground">
          No MCP servers configured.
        </div>
      ) : (
        entries.map(([name, status]) => {
          const isConnected = status.status === "connected";
          const isToggling = toggling === name;
          const type = mcpTypes[name];
          const config = STATUS_CONFIG[status.status as keyof typeof STATUS_CONFIG] ?? {
            variant: "secondary" as const,
            label: "Unknown",
          };
          const BadgeIcon = "icon" in config ? config.icon : undefined;

          return (
            <div key={name} className="flex items-center gap-3 rounded-lg border p-3 bg-card">
              <div className="shrink-0 text-muted-foreground">
                {type === "remote" ? <Globe className="size-4" /> : <Terminal className="size-4" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium font-mono truncate">{name}</span>
                  <Badge
                    variant={config.variant}
                    className={`text-xs${BadgeIcon ? " gap-1" : ""}${"className" in config ? ` ${config.className}` : ""}`}
                  >
                    {BadgeIcon && <BadgeIcon className="size-3" />}
                    {config.label}
                  </Badge>
                </div>
                {status.status === "failed" && "error" in status && (
                  <p className="text-[11px] text-destructive truncate mt-0.5">{status.error}</p>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {isToggling && <Spinner className="size-3.5" />}
                <Switch
                  checked={isConnected}
                  onCheckedChange={() => handleToggle(name, status)}
                  disabled={isToggling}
                />
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
