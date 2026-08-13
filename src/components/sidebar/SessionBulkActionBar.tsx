import { Check, FolderInput, Palette, Pin, Tag, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SessionColor } from "@/lib/persistence";
import { getProjectName } from "@/lib/path";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const COLORS: SessionColor[] = [
  null,
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "gray",
];

const COLOR_SWATCH: Record<Exclude<SessionColor, null>, string> = {
  red: "bg-red-500",
  orange: "bg-orange-500",
  yellow: "bg-yellow-500",
  green: "bg-green-500",
  blue: "bg-blue-500",
  purple: "bg-purple-500",
  pink: "bg-pink-500",
  gray: "bg-gray-500",
};

function BulkIconButton({
  label,
  disabled,
  destructive,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex size-7 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:pointer-events-none disabled:opacity-35 ${
        destructive
          ? "text-destructive hover:bg-destructive/10"
          : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

export function SessionBulkActionBar({
  count,
  allPinned,
  canManage,
  canDelete,
  projects,
  onTogglePin,
  onSetColor,
  onAddTag,
  onMove,
  onDelete,
  onClear,
}: {
  count: number;
  allPinned: boolean;
  canManage: boolean;
  canDelete: boolean;
  projects: string[];
  onTogglePin: () => void;
  onSetColor: (color: SessionColor) => void;
  onAddTag: () => void;
  onMove: (directory: string) => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex h-[68px] shrink-0 flex-col justify-center border-b border-sidebar-border/60 bg-primary/[0.06] px-2 group-data-[collapsible=icon]:hidden"
      role="toolbar"
      data-session-selection-ui
      aria-label={t("sessionMenu.bulkActions")}
    >
      <div className="flex h-7 items-center gap-2 px-1">
        <span className="flex size-5 items-center justify-center rounded bg-primary text-[11px] font-semibold text-primary-foreground">
          {count}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {t("sessionMenu.selectedCount", { count })}
        </span>
        <BulkIconButton label={t("sessionMenu.clearSelection")} onClick={onClear}>
          <X className="size-4" />
        </BulkIconButton>
      </div>
      <div className="mt-1 flex h-7 items-center justify-between px-1">
        <BulkIconButton
          label={allPinned ? t("sessionMenu.unpin") : t("sessionMenu.pin")}
          disabled={!canManage}
          onClick={onTogglePin}
        >
          <Pin className="size-3.5" />
        </BulkIconButton>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t("sessionMenu.setColor")}
            title={t("sessionMenu.setColor")}
            disabled={!canManage}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:pointer-events-none disabled:opacity-35"
          >
            <Palette className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-36" data-session-selection-ui>
            {COLORS.map((color) => (
              <DropdownMenuItem key={color ?? "none"} onClick={() => onSetColor(color)}>
                {color ? (
                  <span className={`size-2.5 rounded-full ${COLOR_SWATCH[color]}`} />
                ) : (
                  <span className="size-2.5 rounded-full border border-muted-foreground/60" />
                )}
                {t(`sessionMenu.colors.${color ?? "none"}`)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <BulkIconButton label={t("sessionMenu.tags")} disabled={!canManage} onClick={onAddTag}>
          <Tag className="size-3.5" />
        </BulkIconButton>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t("sessionMenu.moveToProject")}
            title={t("sessionMenu.moveToProject")}
            disabled={!canManage || projects.length === 0}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:pointer-events-none disabled:opacity-35"
          >
            <FolderInput className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-48" data-session-selection-ui>
            {projects.map((directory) => (
              <DropdownMenuItem key={directory} onClick={() => onMove(directory)}>
                <span className="min-w-0 flex-1 truncate">{getProjectName(directory)}</span>
                <Check className="invisible size-3.5" />
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <BulkIconButton
          label={t("sessionMenu.deleteSelected")}
          disabled={!canDelete}
          destructive
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
        </BulkIconButton>
      </div>
    </div>
  );
}
