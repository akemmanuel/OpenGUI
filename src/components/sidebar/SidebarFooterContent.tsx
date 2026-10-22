import type { SectionId } from "@/components/settings/SettingsView";
import { QuickPreferences } from "@/features/profile/QuickPreferences";
import { FolderOpen, Settings, SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { initialsFor } from "@/features/identity/AccountSection";
import { useIdentityActor } from "@/features/identity/identity-actor-context";
import { abbreviatePath } from "@/lib/path";

export function SidebarFooterContent({
  activeSessionDirectory,
  homeDir,
  onOpenSettings,
  settingsActive,
  onToggleProfile,
  profileOpen,
}: {
  activeSessionDirectory: string | null;
  homeDir: string | null;
  onOpenSettings: (tab?: SectionId) => void;
  settingsActive: boolean;
  onToggleProfile: () => void;
  profileOpen: boolean;
}) {
  const { t } = useTranslation();
  const actor = useIdentityActor();
  const signedIn = actor?.type === "user";
  const profileLabel = signedIn ? actor.displayName : t("profile.preferencesTitle");

  return (
    <SidebarFooter className="border-t border-sidebar-border p-0 gap-0">
      {activeSessionDirectory && !profileOpen && (
        <div
          title={activeSessionDirectory}
          className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground border-b border-sidebar-border group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-b-0 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-2"
        >
          <FolderOpen className="size-3.5 shrink-0" />
          <span
            className="truncate min-w-0 group-data-[collapsible=icon]:hidden"
            data-responsive-allow="text-clip"
          >
            {abbreviatePath(activeSessionDirectory, homeDir ?? "")}
          </span>
        </div>
      )}
      <SidebarMenu className="flex-row items-center gap-1 p-1 group-data-[collapsible=icon]:flex-col">
        <SidebarMenuItem>
          <SidebarMenuButton
            type="button"
            tooltip={t("common.settings")}
            title={t("common.settings")}
            isActive={settingsActive}
            aria-label={t("common.settings")}
            aria-current={settingsActive ? "page" : undefined}
            onClick={() => onOpenSettings()}
            className="size-8 justify-center p-0 text-muted-foreground"
          >
            <Settings />
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <QuickPreferences onOpenAppearance={() => onOpenSettings("appearance")} />
        </SidebarMenuItem>
        {signedIn && (
          <SidebarMenuItem className="min-w-0 flex-1 group-data-[collapsible=icon]:flex-none">
            <SidebarMenuButton
              type="button"
              size="lg"
              tooltip={profileLabel}
              isActive={profileOpen}
              aria-label={t("profile.open")}
              aria-expanded={profileOpen}
              onClick={onToggleProfile}
              className="h-10 gap-2 px-2 data-[active=true]:font-normal"
            >
              {signedIn ? (
                <span
                  aria-hidden="true"
                  className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground group-data-[collapsible=icon]:size-8"
                >
                  {initialsFor(actor.displayName)}
                </span>
              ) : (
                <span
                  aria-hidden="true"
                  className="flex size-7 shrink-0 items-center justify-center rounded-full border border-sidebar-border text-muted-foreground group-data-[collapsible=icon]:size-8"
                >
                  <SlidersHorizontal className="size-3.5" />
                </span>
              )}
              <span className="group-data-[collapsible=icon]:hidden">{profileLabel}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
      </SidebarMenu>
    </SidebarFooter>
  );
}
