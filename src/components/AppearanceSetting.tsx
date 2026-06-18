/**
 * Appearance settings section:
 * - Theme mode (Light / Dark / System)
 * - Contrast slider
 * - Accent color presets (default neutral + 6 colors)
 * - Code font size
 */

import { Ban, CaseSensitive, Monitor, Moon, Palette, SlidersHorizontal, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ThemeMode } from "@/hooks/use-theme";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

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

export function AppearanceSetting() {
  const { t } = useTranslation();
  const {
    mode,
    theme,
    setTheme,
    contrast,
    setContrast,
    accentColor,
    setAccentColor,
    codeFontSize,
    setCodeFontSize,
  } = useTheme();

  return (
    <div className="space-y-3">
      {/* Theme mode row */}
      <div className="flex items-center justify-between gap-3">
        <Label className="text-sm font-normal shrink-0">{t("settings.general.appearance")}</Label>
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={mode}
          onValueChange={(val) => {
            if (val) setTheme(val as ThemeMode);
          }}
        >
          <ToggleGroupItem
            value="light"
            className="h-8 px-2.5 text-xs gap-1.5"
            aria-label={t("settings.general.themeLight")}
          >
            <Sun className="size-3.5" />
            {t("settings.general.themeLight")}
          </ToggleGroupItem>
          <ToggleGroupItem
            value="dark"
            className="h-8 px-2.5 text-xs gap-1.5"
            aria-label={t("settings.general.themeDark")}
          >
            <Moon className="size-3.5" />
            {t("settings.general.themeDark")}
          </ToggleGroupItem>
          <ToggleGroupItem
            value="system"
            className="h-8 px-2.5 text-xs gap-1.5"
            aria-label={t("settings.general.themeSystem")}
          >
            <Monitor className="size-3.5" />
            {t("settings.general.themeSystem")}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* Contrast row */}
      <div className="flex items-center gap-3">
        <SlidersHorizontal className="size-4 text-muted-foreground shrink-0" />
        <Label className="text-sm font-normal shrink-0 w-20">
          {t("settings.general.contrast")}
        </Label>
        <Slider
          value={[contrast ?? 50]}
          onValueChange={([val]) => setContrast(val ?? 50)}
          min={0}
          max={100}
          step={1}
          className="flex-1"
        />
        <span className="text-xs text-muted-foreground tabular-nums w-7 text-right">
          {contrast}
        </span>
      </div>

      {/* Accent color row */}
      <div className="flex items-center gap-3">
        <Palette className="size-4 text-muted-foreground shrink-0" />
        <Label className="text-sm font-normal shrink-0 w-20">{t("settings.general.accent")}</Label>
        <TooltipProvider delayDuration={300}>
          <div className="flex flex-1 items-center gap-2">
            {ACCENT_PRESET_IDS.map((presetId) => {
              const color = ACCENT_PRESET_COLORS[presetId];
              const label = t(`settings.general.accentPreset.${presetId}`);
              const isActive = color
                ? accentColor.toLowerCase() === color.toLowerCase()
                : accentColor === "default";

              return (
                <Tooltip key={presetId}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        "size-6 rounded-full border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background",
                        isActive && "ring-2 ring-foreground/70 ring-offset-2",
                        color ? "border-border" : "border-border flex items-center justify-center",
                      )}
                      style={color ? { backgroundColor: color } : undefined}
                      aria-label={label}
                      onClick={() => setAccentColor(color ?? "default")}
                    >
                      {!color && (
                        <Ban
                          className={cn(
                            "size-3.5",
                            theme === "dark" ? "text-neutral-400" : "text-neutral-500",
                          )}
                        />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    {label}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </TooltipProvider>
      </div>

      {/* Code font size row */}
      <div className="flex items-center gap-3">
        <CaseSensitive className="size-4 text-muted-foreground shrink-0" />
        <Label htmlFor="code-font-size" className="text-sm font-normal shrink-0 w-20">
          {t("settings.general.codeFontSize")}
        </Label>
        <div className="flex flex-1 justify-end items-center gap-2">
          <Input
            id="code-font-size"
            type="number"
            min={10}
            max={20}
            step={1}
            value={codeFontSize}
            onChange={(event) => setCodeFontSize(Number(event.target.value))}
            className="h-8 w-20 text-right font-mono text-sm"
          />
          <span className="text-xs text-muted-foreground">px</span>
        </div>
      </div>
    </div>
  );
}
