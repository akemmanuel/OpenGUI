/**
 * Personal, device-local preferences laid out for the narrow profile panel in
 * the sidebar: every control stacks under its label instead of sitting beside it.
 */

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { NOTIFICATIONS_ENABLED_KEY } from "@/hooks/use-agent-state";
import { useChatWidth } from "@/hooks/use-chat-width";
import { useTheme, type ThemeMode } from "@/hooks/use-theme";
import { detectSystemLanguage, SUPPORTED_LANGUAGE_LIST, type SupportedLanguage } from "@/i18n";
import { DEFAULT_MODEL_MAX_AGE_MONTHS, STORAGE_KEYS } from "@/lib/constants";
import {
  getNewChatModelBehavior,
  isNewChatModelBehavior,
  newChatModelBehaviorLabelKey,
  setNewChatModelBehavior,
  type NewChatModelBehavior,
} from "@/lib/new-chat-model-behavior";
import { storageGet, storageRemove, storageSet } from "@/lib/persistence/storage";
import { isRespondingSidebarEnabled, setRespondingSidebarEnabled } from "@/lib/responding-sidebar";

/** Preset accent colors: "default" = neutral (no custom accent). */
const ACCENT_PRESET_IDS = ["default", "blue", "green", "purple", "orange", "red", "teal"] as const;

const ACCENT_PRESET_COLORS: Record<(typeof ACCENT_PRESET_IDS)[number], string | null> = {
  default: null,
  blue: "#5482ff",
  green: "#22c55e",
  purple: "#a855f7",
  orange: "#f97316",
  red: "#e11d48",
  teal: "#14b8a6",
};

const toggleItem =
  "h-8 min-w-0 flex-1 gap-1.5 px-2 text-xs text-muted-foreground aria-pressed:bg-sidebar-accent aria-pressed:text-foreground";

function StackedSetting({
  label,
  htmlFor,
  help,
  children,
}: {
  label: string;
  htmlFor?: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      {children}
      {help && <p className="text-[11px] leading-4 text-muted-foreground">{help}</p>}
    </div>
  );
}

function SwitchSetting({
  id,
  label,
  help,
  checked,
  onCheckedChange,
  trailing,
  footer,
}: {
  id: string;
  label: string;
  help?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  trailing?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id} className="min-w-0 text-sm font-normal [overflow-wrap:anywhere]">
          {label}
        </Label>
        {trailing ?? (
          <Switch id={id} size="sm" checked={checked} onCheckedChange={onCheckedChange} />
        )}
      </div>
      {help && <p className="text-[11px] leading-4 text-muted-foreground">{help}</p>}
      {footer}
    </div>
  );
}

export function ThemeSetting() {
  const { t } = useTranslation();
  const { mode, setTheme } = useTheme();
  const options = [
    { value: "light", icon: Sun, label: t("settings.general.themeLight") },
    { value: "dark", icon: Moon, label: t("settings.general.themeDark") },
    { value: "system", icon: Monitor, label: t("settings.general.themeSystem") },
  ] as const;
  return (
    <StackedSetting label={t("settings.general.theme")}>
      <ToggleGroup
        type="single"
        variant="outline"
        spacing={0}
        value={mode}
        aria-label={t("settings.general.theme")}
        onValueChange={(value) => {
          if (value) setTheme(value as ThemeMode);
        }}
        className="flex w-full"
      >
        {options.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            aria-label={option.label}
            className={toggleItem}
          >
            <option.icon className="size-3.5" />
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </StackedSetting>
  );
}

export function AccentSetting() {
  const { t } = useTranslation();
  const { accentColor, setAccentColor } = useTheme();
  const selected =
    ACCENT_PRESET_IDS.find((presetId) => {
      const color = ACCENT_PRESET_COLORS[presetId];
      return color ? accentColor.toLowerCase() === color.toLowerCase() : accentColor === "default";
    }) ?? "default";
  return (
    <StackedSetting label={t("settings.general.accent")}>
      <RadioGroup
        value={selected}
        aria-label={t("settings.general.accent")}
        className="flex flex-wrap gap-1.5"
        onValueChange={(value) => {
          const color = ACCENT_PRESET_COLORS[value as (typeof ACCENT_PRESET_IDS)[number]];
          setAccentColor(color ?? "default");
        }}
      >
        {ACCENT_PRESET_IDS.map((presetId) => {
          const color = ACCENT_PRESET_COLORS[presetId];
          const label = t(`settings.general.accentPreset.${presetId}`);
          return (
            <RadioGroupItem
              key={presetId}
              value={presetId}
              aria-label={label}
              title={label}
              className="size-6 border-border ring-offset-sidebar data-checked:border-border data-checked:ring-2 data-checked:ring-foreground/70 data-checked:ring-offset-2"
              style={{ backgroundColor: color ?? "var(--foreground)" }}
            />
          );
        })}
      </RadioGroup>
    </StackedSetting>
  );
}

export function ContrastSetting() {
  const { t } = useTranslation();
  const { contrast, setContrast } = useTheme();
  const id = useId();
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label id={id} className="text-xs font-medium text-muted-foreground">
          {t("settings.general.contrast")}
        </Label>
        <span className="text-xs tabular-nums text-muted-foreground">{contrast}</span>
      </div>
      <Slider
        aria-labelledby={id}
        value={[contrast ?? 50]}
        onValueChange={([value]) => setContrast(value ?? 50)}
        min={0}
        max={100}
        step={1}
      />
    </div>
  );
}

export function ChatWidthSetting() {
  const { t } = useTranslation();
  const [chatWidth, setChatWidth] = useChatWidth();
  const id = useId();
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label id={id} className="text-xs font-medium text-muted-foreground">
          {t("settings.general.chatWidth")}
        </Label>
        <span className="text-xs tabular-nums text-muted-foreground">{chatWidth}%</span>
      </div>
      <Slider
        aria-labelledby={id}
        aria-valuetext={`${chatWidth}%`}
        value={[chatWidth]}
        onValueChange={([value]) => setChatWidth(value ?? 70)}
        min={40}
        max={100}
        step={1}
      />
    </div>
  );
}

const isSupportedLanguage = (value: string | null): value is SupportedLanguage =>
  SUPPORTED_LANGUAGE_LIST.includes(value as SupportedLanguage);

function storedLanguage(): "auto" | SupportedLanguage {
  const value = storageGet(STORAGE_KEYS.LANGUAGE);
  return isSupportedLanguage(value) ? value : "auto";
}

/** The chosen interface language ("auto" follows the system) and a setter that applies it. */
export function useLanguagePreference() {
  const { i18n } = useTranslation();
  const [language, setLanguage] = useState(storedLanguage);

  useEffect(() => {
    const onLanguageChanged = () => setLanguage(storedLanguage());
    window.addEventListener("opengui-language-changed", onLanguageChanged);
    return () => window.removeEventListener("opengui-language-changed", onLanguageChanged);
  }, []);

  const choose = (value: "auto" | SupportedLanguage) => {
    setLanguage(value);
    if (value === "auto") {
      storageRemove(STORAGE_KEYS.LANGUAGE);
      void detectSystemLanguage().then((detected) => i18n.changeLanguage(detected));
    } else {
      storageSet(STORAGE_KEYS.LANGUAGE, value);
      void i18n.changeLanguage(value);
    }
    window.dispatchEvent(new Event("opengui-language-changed"));
  };

  return [language, choose] as const;
}

export function LanguageOptions() {
  const { t } = useTranslation();
  const [language, choose] = useLanguagePreference();
  const options = ["auto", ...SUPPORTED_LANGUAGE_LIST] as const;
  return (
    <RadioGroup
      value={language}
      aria-label={t("settings.general.language")}
      className="gap-0.5"
      onValueChange={(value) => choose(value as (typeof options)[number])}
    >
      {options.map((code) => (
        <Label
          key={code}
          className="flex h-9 cursor-pointer items-center gap-3 rounded-md px-2 text-sm font-normal transition-colors hover:bg-sidebar-accent"
        >
          <RadioGroupItem value={code} />
          {code === "auto" ? t("common.autoDetect") : t(`languages.${code}`)}
        </Label>
      ))}
    </RadioGroup>
  );
}

export function NewChatModelSetting() {
  const { t } = useTranslation();
  const [behavior, setBehavior] = useState<NewChatModelBehavior>(() => getNewChatModelBehavior());
  return (
    <StackedSetting
      label={t("settings.general.newChatModelBehavior")}
      htmlFor="new-chat-model-behavior"
    >
      <Select
        value={behavior}
        onValueChange={(value) => {
          if (!isNewChatModelBehavior(value)) return;
          setBehavior(value);
          setNewChatModelBehavior(value);
        }}
      >
        <SelectTrigger id="new-chat-model-behavior" className="h-8 w-full">
          <SelectValue
            placeholder={t("settings.general.newChatModelBehavior")}
            data-responsive-allow="text-clip"
          >
            {t(newChatModelBehaviorLabelKey(behavior))}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ask">{t("settings.general.newChatModelAsk")}</SelectItem>
          <SelectItem value="last">{t("settings.general.newChatModelLast")}</SelectItem>
          <SelectItem value="workspace-default">
            {t("settings.general.newChatModelWorkspaceDefault")}
          </SelectItem>
        </SelectContent>
      </Select>
    </StackedSetting>
  );
}

export function RespondingSidebarSetting() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(isRespondingSidebarEnabled);
  return (
    <SwitchSetting
      id="responding-sidebar-toggle"
      label={t("settings.general.respondingSidebar")}
      help={t("settings.general.respondingSidebarHelp")}
      checked={enabled}
      onCheckedChange={(checked) => {
        setEnabled(checked);
        setRespondingSidebarEnabled(checked);
      }}
    />
  );
}

function readModelAge() {
  const raw = storageGet(STORAGE_KEYS.MODEL_MAX_AGE_MONTHS);
  if (raw === null) return { enabled: true, months: String(DEFAULT_MODEL_MAX_AGE_MONTHS) };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { enabled: !Number.isFinite(parsed), months: String(DEFAULT_MODEL_MAX_AGE_MONTHS) };
  }
  return { enabled: true, months: String(Math.round(parsed)) };
}

export function ModelAgeFilterSetting() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(() => readModelAge().enabled);
  const [months, setMonths] = useState(() => readModelAge().months);

  const broadcastChange = () => window.dispatchEvent(new Event("model-max-age-months-changed"));
  const persistMonths = (value: string) => {
    const parsed = Number(value);
    storageSet(
      STORAGE_KEYS.MODEL_MAX_AGE_MONTHS,
      String(
        Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : DEFAULT_MODEL_MAX_AGE_MONTHS,
      ),
    );
    broadcastChange();
  };

  useEffect(() => {
    if (!enabled) return;
    const timeout = window.setTimeout(() => {
      if (months) persistMonths(months);
    }, 400);
    return () => window.clearTimeout(timeout);
    // persistMonths is stable for this setting; debounce only months/enabled
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [months, enabled]);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="model-age-filter-toggle" className="min-w-0 text-sm font-normal">
          {t("settings.general.hideOldModels")}
        </Label>
        <Switch
          id="model-age-filter-toggle"
          size="sm"
          checked={enabled}
          onCheckedChange={(checked) => {
            setEnabled(checked);
            if (!checked) {
              storageSet(STORAGE_KEYS.MODEL_MAX_AGE_MONTHS, "0");
              broadcastChange();
              return;
            }
            persistMonths(months);
          }}
        />
      </div>
      {enabled && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Label htmlFor="model-age-filter-months" className="text-xs font-normal">
            {t("settings.general.olderThan")}
          </Label>
          <Input
            id="model-age-filter-months"
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            value={months}
            onChange={(event) => setMonths(event.target.value.replace(/[^0-9]/g, ""))}
            onBlur={() => {
              if (months) return;
              const fallback = String(DEFAULT_MODEL_MAX_AGE_MONTHS);
              setMonths(fallback);
              persistMonths(fallback);
            }}
            className="h-7 w-14 px-2 text-center font-mono text-xs tabular-nums"
          />
          <span>{t("settings.general.months")}</span>
        </div>
      )}
      <p className="text-[11px] leading-4 text-muted-foreground">
        {t("settings.general.hideOldModelsHelp")}
      </p>
    </div>
  );
}

export function NotificationsSetting() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(() => {
    const raw = storageGet(NOTIFICATIONS_ENABLED_KEY);
    return raw === null || raw === "true";
  });
  const permissionDenied =
    typeof Notification !== "undefined" && Notification.permission === "denied";

  return (
    <SwitchSetting
      id="notifications-toggle"
      label={t("settings.general.desktopNotifications")}
      checked={enabled}
      onCheckedChange={async (checked) => {
        if (
          checked &&
          typeof Notification !== "undefined" &&
          Notification.permission === "default"
        ) {
          const result = await Notification.requestPermission();
          if (result === "denied") return;
        }
        setEnabled(checked);
        storageSet(NOTIFICATIONS_ENABLED_KEY, String(checked));
      }}
      trailing={permissionDenied ? <span /> : undefined}
      footer={
        permissionDenied ? (
          <p className="text-[11px] leading-4 text-muted-foreground">
            <span className="font-medium text-foreground">
              {t("settings.general.blockedByBrowser")}
            </span>
            {". "}
            {t("settings.general.blockedByBrowserHelp")}
          </p>
        ) : undefined
      }
    />
  );
}
