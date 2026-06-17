import { Search, SquarePen, X } from "lucide-react";
import type { RefObject } from "react";
import { Input } from "@/components/ui/input";
import { SidebarHeader } from "@/components/ui/sidebar";
import logoDark from "../../../opencode-logo-dark.svg";
import logoLight from "../../../opencode-logo-light.svg";
import openguiLogoDark from "../../../opengui-dark.svg";
import openguiLogoLight from "../../../opengui-light.svg";

export function SidebarHeaderContent({
  searchInputRef,
  searchQuery,
  hasActiveSearch,
  detachedProject,
  defaultChatDirectory,
  labels,
  setSearchQuery,
  onOpenChat,
  startNewChat,
  closeMobileSidebar,
}: {
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  hasActiveSearch: boolean;
  detachedProject?: string;
  defaultChatDirectory?: string | null;
  labels: {
    searchPlaceholder: string;
    clearSearch: string;
    newChat: string;
  };
  setSearchQuery: (value: string) => void;
  onOpenChat: () => void;
  startNewChat: () => void | Promise<void>;
  closeMobileSidebar: () => void;
}) {
  return (
    <SidebarHeader className="border-b border-sidebar-border p-0 gap-0 group-data-[collapsible=icon]:p-2">
      <div
        className="flex items-center justify-center gap-2 h-9 shrink-0 border-b border-sidebar-border group-data-[collapsible=icon]:h-auto group-data-[collapsible=icon]:border-b-0"
        style={
          {
            WebkitAppRegion: "drag",
            userSelect: "none",
            WebkitUserSelect: "none",
          } as React.CSSProperties
        }
      >
        <img
          src={logoDark}
          alt="OpenGUI"
          className="size-6 shrink-0 hidden group-data-[collapsible=icon]:dark:block"
        />
        <img
          src={logoLight}
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
      </div>
      <div className="group-data-[collapsible=icon]:hidden border-b border-sidebar-border/60 bg-sidebar/40">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
          <Input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={labels.searchPlaceholder}
            className="h-8 pl-8 pr-8 text-sm rounded-none border-0 focus:ring-0 focus-visible:ring-0"
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
      {!detachedProject && defaultChatDirectory && (
        <div className="group-data-[collapsible=icon]:hidden border-b border-sidebar-border">
          <button
            type="button"
            onClick={() => {
              onOpenChat();
              void startNewChat();
              closeMobileSidebar();
            }}
            className="flex h-10 w-full items-center gap-2 px-3 text-left text-sm font-medium transition-colors hover:bg-sidebar-accent/70 hover:text-foreground"
          >
            <SquarePen className="size-4 shrink-0" />
            <span>{labels.newChat}</span>
          </button>
        </div>
      )}
    </SidebarHeader>
  );
}
