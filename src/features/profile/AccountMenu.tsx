import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import {
  ChevronsUpDown,
  Languages,
  LogOut,
  Monitor,
  Moon,
  Palette,
  ScrollText,
  Settings,
  Sun,
  UserRound,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import type { SectionId } from "@/components/settings/SettingsView";
import { initialsFor } from "@/features/identity/AccountSection";
import { useIdentityActor } from "@/features/identity/identity-actor-context";
import { logoutActiveWorkspaceIdentity } from "@/features/identity/workspace-identity";
import { usePersonalInstructionsAvailable } from "@/features/instructions/InstructionsSettings";
import { useTheme, type ThemeMode } from "@/hooks/use-theme";
import { SUPPORTED_LANGUAGE_LIST, type SupportedLanguage } from "@/i18n";
import { useLanguagePreference } from "./PreferenceControls";

export type ProfileView = "account" | "instructions";

const THEME_OPTIONS = [
  { value: "light", icon: Sun, labelKey: "settings.general.themeLight" },
  { value: "dark", icon: Moon, labelKey: "settings.general.themeDark" },
  { value: "system", icon: Monitor, labelKey: "settings.general.themeSystem" },
] as const;

/**
 * The single entry point for everything personal: account, personal
 * instructions, the appearance toggles people reach for mid-session, and
 * Settings. Host-wide configuration stays in Settings.
 */
export function AccountMenu({
  active,
  onOpenSettings,
  onOpenProfile,
}: {
  active: boolean;
  onOpenSettings: (tab?: SectionId) => void;
  onOpenProfile: (view: ProfileView) => void;
}) {
  const { t } = useTranslation();
  const actor = useIdentityActor();
  const signedIn = actor?.type === "user";
  const showInstructions = usePersonalInstructionsAvailable();
  const { mode, setTheme } = useTheme();
  const [language, chooseLanguage] = useLanguagePreference();
  const [signingOut, setSigningOut] = useState(false);
  const label = signedIn ? actor.displayName : t("common.settings");
  const languageLabel = (code: "auto" | SupportedLanguage) =>
    code === "auto" ? t("common.autoDetect") : t(`languages.${code}`);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          type="button"
          size="lg"
          isActive={active}
          aria-label={t("profile.open")}
          className="h-11 gap-2.5 px-2 data-[active=true]:font-normal data-popup-open:bg-sidebar-accent"
        >
          {signedIn ? (
            <span
              aria-hidden="true"
              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground"
            >
              {initialsFor(actor.displayName)}
            </span>
          ) : (
            <span
              aria-hidden="true"
              className="flex size-7 shrink-0 items-center justify-center rounded-full border border-sidebar-border text-muted-foreground"
            >
              <Settings className="size-3.5" />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          <ChevronsUpDown className="text-muted-foreground" aria-hidden="true" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={6}
        className="w-(--anchor-width) min-w-60 max-w-[calc(100vw-1rem)]"
      >
        {(signedIn || showInstructions) && (
          <>
            <DropdownMenuGroup>
              {signedIn && (
                <DropdownMenuItem className="h-8" onClick={() => onOpenProfile("account")}>
                  <UserRound className="text-muted-foreground" />
                  {t("profile.account")}
                </DropdownMenuItem>
              )}
              {showInstructions && (
                <DropdownMenuItem className="h-8" onClick={() => onOpenProfile("instructions")}>
                  <ScrollText className="text-muted-foreground" />
                  {t("profile.personalInstructions")}
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        )}
        <div className="flex h-9 items-center gap-2 pl-1.5">
          <span className="min-w-0 flex-1 truncate text-sm">{t("settings.general.theme")}</span>
          <MenuPrimitive.RadioGroup
            value={mode}
            onValueChange={(value) => setTheme(value as ThemeMode)}
            aria-label={t("settings.general.theme")}
            className="flex shrink-0 items-center rounded-md bg-muted p-0.5"
          >
            {THEME_OPTIONS.map((option) => (
              <MenuPrimitive.RadioItem
                key={option.value}
                value={option.value}
                aria-label={t(option.labelKey)}
                title={t(option.labelKey)}
                className="flex size-7 cursor-default items-center justify-center rounded-[5px] text-muted-foreground outline-hidden transition-colors data-highlighted:text-foreground data-highlighted:ring-1 data-highlighted:ring-ring data-checked:bg-background data-checked:text-foreground data-checked:shadow-[0_1px_2px_rgb(0_0_0/0.18)]"
              >
                <option.icon className="size-3.5" aria-hidden="true" />
              </MenuPrimitive.RadioItem>
            ))}
          </MenuPrimitive.RadioGroup>
        </div>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="h-8">
            <Languages className="text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{t("settings.general.language")}</span>
            <span className="truncate text-xs text-muted-foreground">
              {languageLabel(language)}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-40">
            <DropdownMenuRadioGroup
              value={language}
              onValueChange={(value) => chooseLanguage(value as "auto" | SupportedLanguage)}
            >
              {(["auto", ...SUPPORTED_LANGUAGE_LIST] as const).map((code) => (
                <DropdownMenuRadioItem key={code} value={code} className="h-8">
                  {languageLabel(code)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem className="h-8" onClick={() => onOpenSettings("appearance")}>
          <Palette className="text-muted-foreground" />
          {t("profile.moreAppearance")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="h-8" onClick={() => onOpenSettings()}>
          <Settings className="text-muted-foreground" />
          {t("common.settings")}
        </DropdownMenuItem>
        {signedIn && (
          <DropdownMenuItem
            className="h-8"
            disabled={signingOut}
            onClick={async () => {
              setSigningOut(true);
              try {
                await logoutActiveWorkspaceIdentity();
              } catch {
                toast.error(t("account.logoutFailed"));
              } finally {
                setSigningOut(false);
              }
            }}
          >
            <LogOut className="text-muted-foreground" />
            {t("identity.signOut")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
