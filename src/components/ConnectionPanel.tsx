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
