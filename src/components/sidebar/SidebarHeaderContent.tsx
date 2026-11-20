import { PanelLeftIcon, Search, SquarePen, X } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { getProjectName } from "@/lib/path";
import { Input } from "@/components/ui/input";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { SidebarHeader, useSidebar } from "@/components/ui/sidebar";
import { WorkspaceSwitcher } from "@/components/title-bar/WorkspaceSwitcher";
import appIcon from "../../../assets/app-icon.svg";
import openguiLogoDark from "../../../assets/opengui-dark.svg";
import openguiLogoLight from "../../../assets/opengui-light.svg";

export function SidebarHeaderContent({
  searchInputRef,
  searchQuery,
  hasActiveSearch,
  detachedProject,
  showChatsSection,
  newChatDirectory,
  labels,
  setSearchQuery,
  onOpenChat,
  startNewChat,
  closeMobileSidebar,
  projectSelector,
  selectionActions,
}: {
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  hasActiveSearch: boolean;
  detachedProject?: string;
  showChatsSection: boolean;
  newChatDirectory?: string | null;
  labels: {
    searchPlaceholder: string;
    clearSearch: string;
    newChat: string;
  };
  setSearchQuery: (value: string) => void;
  onOpenChat: () => void;
  startNewChat: () => void | Promise<void>;
  closeMobileSidebar: () => void;
  projectSelector?: ReactNode;
  selectionActions?: ReactNode;
}) {
  const { t } = useTranslation();
  const { toggleSidebar } = useSidebar();

  const newChatAction = !detachedProject && showChatsSection && (
    <div className="mx-3 mt-1 mb-2 group-data-[collapsible=icon]:hidden">
      <button
        type="button"
        aria-label={labels.newChat}
        onClick={() => {
          onOpenChat();
          void startNewChat();
          closeMobileSidebar();
        }}
        className="flex min-h-10 w-full items-center gap-2.5 rounded-md bg-sidebar-accent/60 px-2 text-left text-sm font-semibold text-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-sidebar-ring"
      >
        <SquarePen className="size-4 shrink-0 text-primary" />
        <span className="flex min-w-0 flex-col py-1.5">
          <span>{labels.newChat}</span>
          {newChatDirectory && (
            <span
              className="truncate text-xs font-normal text-muted-foreground"
              title={newChatDirectory}
              data-responsive-allow="text-clip"
            >
              {getProjectName(newChatDirectory)}
            </span>
          )}
        </span>
      </button>
    </div>
  );

  return (
    <SidebarHeader className="gap-0 p-0 group-data-[collapsible=icon]:p-2">
      {selectionActions ? (
        <>
          {selectionActions}
          {newChatAction}
        </>
      ) : (
        <>
          <div
            className="flex items-center justify-start gap-2 h-12 shrink-0 px-3 group-data-[collapsible=icon]:h-auto group-data-[collapsible=icon]:justify-center "
            style={
              {
                WebkitAppRegion: "drag",
                userSelect: "none",
                WebkitUserSelect: "none",
              } as React.CSSProperties
            }
          >
            {!detachedProject && (
              <Button
                data-sidebar="trigger"
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                title={`${t("workspace.hideSidebar")} (Ctrl+B)`}
                onClick={toggleSidebar}
              >
                <PanelLeftIcon />
                <span className="sr-only">{t("workspace.hideSidebar")}</span>
              </Button>
            )}
            <img
              src={appIcon}
              alt="OpenGUI"
              className="size-6 shrink-0 hidden group-data-[collapsible=icon]:dark:block"
            />
            <img
              src={appIcon}
              alt="OpenGUI"
              className="size-6 shrink-0 hidden group-data-[collapsible=icon]:block group-data-[collapsible=icon]:dark:hidden"
            />
            <img
              src={openguiLogoDark}
              alt="OpenGUI"
              className="h-5 hidden dark:block group-data-[collapsible=icon]:!hidden"
            />
            <img
              src={openguiLogoLight}
              alt="OpenGUI"
              className="h-5 block dark:hidden group-data-[collapsible=icon]:!hidden"
            />
            {!detachedProject && (
              <div className="ml-auto flex min-w-0 justify-end">
                <WorkspaceSwitcher />
              </div>
            )}
          </div>
          {newChatAction}
          {projectSelector}
          <div className="mx-3 mb-2 group-data-[collapsible=icon]:hidden">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                aria-label={labels.searchPlaceholder}
                placeholder={labels.searchPlaceholder}
                className="h-9 border-sidebar-border bg-background/80 pr-8 pl-8 text-sm dark:bg-background/55"
              />
              {hasActiveSearch && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery("");
                    searchInputRef.current?.focus({ preventScroll: true });
                  }}
                  className="absolute right-2 top-1/2 flex size-4.5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground/75 transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
                  aria-label={labels.clearSearch}
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </SidebarHeader>
  );
}
