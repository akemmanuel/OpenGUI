import type { MouseEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SidebarRow({
  label,
  onActivate,
  children,
  actions,
  leadingAction,
  active = false,
  editing = false,
  className,
}: {
  label: string;
  onActivate: (event: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  actions?: ReactNode;
  leadingAction?: ReactNode;
  active?: boolean;
  editing?: boolean;
  className?: string;
}) {
  const contentClassName = cn(
    "flex h-8 min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-hidden transition-[background-color,color,box-shadow] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:flex-none group-data-[collapsible=icon]:p-2!",
    active &&
      "bg-sidebar-accent font-medium text-sidebar-accent-foreground shadow-[inset_0_0_0_1px_var(--sidebar-border)]",
  );

  return (
    <div
      className={cn(
        "flex min-w-0 items-center group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:overflow-hidden",
        className,
      )}
    >
      {leadingAction}
      {editing ? (
        <div className={contentClassName}>{children}</div>
      ) : (
        <button type="button" aria-label={label} className={contentClassName} onClick={onActivate}>
          {children}
        </button>
      )}
      {actions}
    </div>
  );
}
