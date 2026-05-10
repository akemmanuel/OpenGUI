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
import { useCallback, useEffect, useState } from "react";
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
            <TabsTrigger value="skills" className="flex-1">
              {t("settings.tabs.skills")}
            </TabsTrigger>
            <TabsTrigger value="marketplace" className="flex-1">
              <ShoppingBag className="size-3.5 mr-1.5" />
              {t("settings.tabs.marketplace")}
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
          <TabsContent value="skills" className="mt-0 rounded-lg border p-4">
            <SkillsTabContent />
          </TabsContent>
          <TabsContent value="marketplace" className="mt-0 rounded-lg border p-4">
            <SkillsMarketplace />
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
  const backendId = useCurrentAgentBackendId();
  const backend = useAgentBackend(backendId);
  const serverApi = backend?.platform?.server;
  const [restarting, setRestarting] = useState(false);

  const handleRestart = useCallback(async () => {
    if (!serverApi) return;
    setRestarting(true);
    try {
      await serverApi.stop();
      await new Promise((r) => setTimeout(r, 1000));
      await serverApi.start();
      await new Promise((r) => setTimeout(r, 2000));
    } finally {
      setRestarting(false);
    }
  }, [serverApi]);

  return (
    <div className="flex flex-col gap-4">
      <AppearanceSetting />
      <LanguageSetting />
      <DefaultChatDirectorySetting />
      <FileManagerSetting />
      <TerminalSetting />
      <ModelAgeFilterSetting />
      <NotificationsToggle />
      {serverApi && (
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
      )}
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
// Skills tab content (inline)
// ---------------------------------------------------------------------------

interface SkillInfo {
  name: string;
  description: string;
  location: string;
  content: string;
}

function SkillsTabContent() {
  const { t } = useTranslation();
  const initialBackendId = useCurrentAgentBackendId();
  const availableBackendIds = useAvailableBackendIds();
  const [backendId, setBackendId] = useState<AgentBackendId>(initialBackendId);
  const backend = useAgentBackend(backendId);
  const skillsApi = backend?.platform?.skills;
  const { activeDirectory, activeWorkspaceId } = useConnectionState();
  const scopedDirectory = activeDirectory ?? undefined;

  const [sdkSkills, setSdkSkills] = useState<SkillInfo[]>([]);
  const [fsSkills, setFsSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"all" | "sdk" | "installed">("all");

  const refresh = useCallback(async () => {
    if (!skillsApi) return;
    setLoading(true);
    try {
      const [sdk, installed] = await Promise.all([
        skillsApi
          .list({ directory: scopedDirectory, workspaceId: activeWorkspaceId })
          .catch(() => []),
        skillsApi.listInstalled(scopedDirectory).catch(() => []),
      ]);
      setSdkSkills(sdk as SkillInfo[]);
      setFsSkills(installed as SkillInfo[]);
    } finally {
      setLoading(false);
    }
  }, [skillsApi, scopedDirectory, activeWorkspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const getSourceType = (location: string): "local" | "url" => {
    if (location.startsWith("http://") || location.startsWith("https://")) {
      return "url";
    }
    return "local";
  };

  const handleRemove = useCallback(
    async (name: string) => {
      if (!skillsApi) return;
      try {
        await skillsApi.remove(name, scopedDirectory, false);
        await refresh();
      } catch {}
    },
    [skillsApi, scopedDirectory, refresh],
  );

  const handleUpdate = useCallback(
    async (name: string) => {
      if (!skillsApi) return;
      try {
        await skillsApi.update(name, scopedDirectory, false);
        await refresh();
      } catch {}
    },
    [skillsApi, scopedDirectory, refresh],
  );

  // Merge and deduplicate
  const allSkills = useCallback(() => {
    const seen = new Set<string>();
    const merged: SkillInfo[] = [];
    for (const s of [...sdkSkills, ...fsSkills]) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      merged.push(s);
    }
    return merged;
  }, [sdkSkills, fsSkills]);

  const currentSkills =
    activeTab === "sdk" ? sdkSkills : activeTab === "installed" ? fsSkills : allSkills();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner className="size-5" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {availableBackendIds.length > 1 && (
        <div className="flex flex-wrap gap-1">
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

      {/* Browse Marketplace CTA */}
      <div className="flex items-center justify-between rounded-lg border bg-gradient-to-r from-primary/5 to-primary/10 p-4">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">{t("settings.tabs.marketplace")}</p>
          <p className="text-xs text-muted-foreground">{t("settings.skills.browseMarketplace")}</p>
        </div>
        <span className="text-2xl">🛍️</span>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 border-b pb-2">
        <button
          type="button"
          className={`text-xs font-medium px-2.5 py-1 rounded-t transition-colors ${
            activeTab === "all"
              ? "text-foreground border-b-2 border-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("all")}
        >
          All ({allSkills().length})
        </button>
        <button
          type="button"
          className={`text-xs font-medium px-2.5 py-1 rounded-t transition-colors ${
            activeTab === "sdk"
              ? "text-foreground border-b-2 border-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("sdk")}
        >
          {t("settings.skills.sdkSkills")} ({sdkSkills.length})
        </button>
        <button
          type="button"
          className={`text-xs font-medium px-2.5 py-1 rounded-t transition-colors ${
            activeTab === "installed"
              ? "text-foreground border-b-2 border-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("installed")}
        >
          {t("settings.skills.installedSkills")} ({fsSkills.length})
        </button>
      </div>

      <div className="space-y-2">
        {currentSkills.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            {t("settings.skills.noSkills")}
          </div>
        ) : (
          currentSkills.map((skill) => {
            const source = getSourceType(skill.location);
            const isFs = fsSkills.some((s) => s.name === skill.name);
            return (
              <div
                key={skill.name}
                className="flex items-start gap-3 rounded-lg border p-3 bg-card"
              >
                <BookOpen className="size-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{skill.name}</span>
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                      {source === "url" ? t("settings.skills.remote") : t("settings.skills.local")}
                    </Badge>
                    {isFs && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {t("settings.skills.installedSkills")}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{skill.description}</p>
                  <p className="text-[10px] text-muted-foreground font-mono truncate mt-1">
                    {skill.location}
                  </p>
                </div>
                {isFs && (
                  <div className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-[11px]"
                      onClick={() => handleUpdate(skill.name)}
                    >
                      {t("settings.skills.update")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-[11px] text-destructive hover:text-destructive"
                      onClick={() => handleRemove(skill.name)}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                )}
              </div>
            );
          })
        )}
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
