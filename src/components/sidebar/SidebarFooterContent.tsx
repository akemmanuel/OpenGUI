import { FolderOpen } from "lucide-react";
import { ConnectionPanel } from "@/components/ConnectionPanel";
import { SidebarFooter } from "@/components/ui/sidebar";
import { abbreviatePath } from "@/lib/utils";

export function SidebarFooterContent({
  activeSessionDirectory,
  homeDir,
  onOpenSettings,
  settingsActive,
}: {
  activeSessionDirectory: string | null;
  homeDir: string | null;
  onOpenSettings: () => void;
  settingsActive: boolean;
}) {
  return (
    <SidebarFooter className="border-t border-sidebar-border p-0 gap-0">
      {activeSessionDirectory && (
        <div
          title={activeSessionDirectory}
          className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground border-b border-sidebar-border group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-b-0 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-2"
        >
          <FolderOpen className="size-3.5 shrink-0" />
          <span className="truncate min-w-0 group-data-[collapsible=icon]:hidden">
            {abbreviatePath(activeSessionDirectory, homeDir ?? "")}
          </span>
        </div>
      )}
      <div className="flex justify-center p-1 group-data-[collapsible=icon]:px-0">
        <ConnectionPanel onOpenSettings={onOpenSettings} isActive={settingsActive} />
      </div>
    </SidebarFooter>
  );
}
