import * as React from "react";

import { useIsMobile } from "@/hooks/use-mobile";
import { persistSidebarOpenState } from "./sidebar-persistence";

export const SIDEBAR_KEYBOARD_SHORTCUT = "b";

export function isSidebarKeyboardShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">,
): boolean {
  return event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey);
}

export function useSidebarController({
  defaultOpen,
  open: openProp,
  onOpenChange,
}: {
  defaultOpen: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = React.useState(false);
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const open = openProp ?? internalOpen;

  const setOpen = React.useCallback(
    (value: boolean | ((current: boolean) => boolean)) => {
      const nextOpen = typeof value === "function" ? value(open) : value;
      if (onOpenChange) onOpenChange(nextOpen);
      else setInternalOpen(nextOpen);
      persistSidebarOpenState(nextOpen);
    },
    [onOpenChange, open],
  );

  const toggleSidebar = React.useCallback(() => {
    if (isMobile) setOpenMobile((current) => !current);
    else setOpen((current) => !current);
  }, [isMobile, setOpen]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isSidebarKeyboardShortcut(event)) return;
      event.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleSidebar]);

  return {
    isMobile,
    open,
    setOpen,
    openMobile,
    setOpenMobile,
    toggleSidebar,
  };
}
