/**
 * Server connection settings.
 * Sidebar entry opens settings view in main content area.
 */

import { Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";

export { SettingsView } from "@/components/settings/SettingsView";

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
    <SidebarMenu className="group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:p-0">
      <SidebarMenuItem className="group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
        <SidebarMenuButton
          tooltip={t("common.settings")}
          isActive={isActive}
          onClick={onOpenSettings}
          className="group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:min-w-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:!p-0 group-data-[collapsible=icon]:[&>span]:hidden"
        >
          <Settings className="size-4 shrink-0" />
          <span>{t("common.settings")}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
