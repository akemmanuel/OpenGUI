import { Bell, Folder, FolderOpen, Globe, Layers, RotateCcw, Terminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { NOTIFICATIONS_ENABLED_KEY, useActions, useConnectionState } from "@/hooks/use-agent-state";
import { detectSystemLanguage } from "@/i18n";
import { DEFAULT_MODEL_MAX_AGE_MONTHS, STORAGE_KEYS } from "@/lib/constants";
import { getDesktopShellClient } from "@/runtime/clients";
import { storageGet, storageRemove, storageSet } from "@/lib/safe-storage";
import packageJson from "../../../package.json";

// ---------------------------------------------------------------------------
// General settings (wraps all general tab items)
// ---------------------------------------------------------------------------

export function GeneralSettings() {
  const { t } = useTranslation();
  const shell = getDesktopShellClient();
  const [restarting, setRestarting] = useState(false);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try {
      await shell.backend?.restart();
      window.location.reload();
    } catch (error) {
      console.error("Failed to restart local backend", error);
      setRestarting(false);
    }
  }, [shell.backend]);

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
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={restarting || !shell.backend}
          >
            {restarting ? (
              <Spinner className="size-3.5 mr-2" />
            ) : (
              <RotateCcw className="size-3.5 mr-2" />
            )}
            {t("settings.general.restartLocalBackend")}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.general.restartLocalBackendTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.general.restartLocalBackendDescription")}
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
