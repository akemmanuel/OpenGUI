import { Palette } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AccentSetting,
  ChatWidthSetting,
  ContrastSetting,
  ThemeSetting,
  useLanguagePreference,
} from "./PreferenceControls";
import { FontSizeSetting } from "./FontSizeSetting";
import { SUPPORTED_LANGUAGE_LIST, type SupportedLanguage } from "@/i18n";

export function QuickPreferences({ onOpenAppearance }: { onOpenAppearance: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [language, choose] = useLanguagePreference();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <SidebarMenuButton
          type="button"
          title={t("settings.quick.title")}
          aria-label={t("settings.quick.title")}
          className="size-8 justify-center p-0 text-muted-foreground"
        >
          <Palette />
        </SidebarMenuButton>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={10}
        className="w-72 max-w-[calc(100vw-1rem)] max-h-[calc(100dvh-5rem)] overflow-y-auto gap-4 p-4"
      >
        <PopoverTitle>{t("settings.quick.title")}</PopoverTitle>
        <ThemeSetting />
        <AccentSetting />
        <FontSizeSetting />
        <ContrastSetting />
        <ChatWidthSetting />
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            {t("settings.general.language")}
          </span>
          <Select
            value={language}
            onValueChange={(value) => {
              if (value) choose(value as "auto" | SupportedLanguage);
            }}
          >
            <SelectTrigger aria-label={t("settings.general.language")} className="w-full">
              <SelectValue>
                {language === "auto" ? t("common.autoDetect") : t(`languages.${language}`)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(["auto", ...SUPPORTED_LANGUAGE_LIST] as const).map((code) => (
                <SelectItem key={code} value={code}>
                  {code === "auto" ? t("common.autoDetect") : t(`languages.${code}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="ghost"
          className="h-auto whitespace-normal text-xs"
          onClick={() => {
            setOpen(false);
            onOpenAppearance();
          }}
        >
          {t("settings.quick.allAppearance")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
