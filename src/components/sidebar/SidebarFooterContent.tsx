import type { SectionId } from "@/components/settings/SettingsView";
import { AccountMenu, type ProfileView } from "@/features/profile/AccountMenu";
import { SidebarFooter, SidebarMenu, SidebarMenuItem } from "@/components/ui/sidebar";

export function SidebarFooterContent({
  onOpenSettings,
  settingsActive,
  onOpenProfile,
  profileOpen,
}: {
  onOpenSettings: (tab?: SectionId) => void;
  settingsActive: boolean;
  onOpenProfile: (view: ProfileView) => void;
  profileOpen: boolean;
}) {
  return (
    <SidebarFooter className="border-t border-sidebar-border p-1.5 gap-0">
      <SidebarMenu>
        <SidebarMenuItem>
          <AccountMenu
            active={settingsActive || profileOpen}
            onOpenSettings={onOpenSettings}
            onOpenProfile={onOpenProfile}
          />
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}
