import {
  Copy,
  FolderOpen,
  Minimize2,
  MoreHorizontal,
  Pin,
  PinOff,
  SquarePen,
  Terminal,
  X,
} from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import * as ContextMenu from "@/components/ui/context-menu";
import { STORAGE_KEYS } from "@/lib/constants";
import { storageGet } from "@/lib/persistence/storage";
import { copyTextToClipboard } from "@/lib/browser";
import {
  SessionMenuContent,
  type SessionMenuProps,
  type SessionMenuSlots,
} from "@/components/sidebar-item-menus/SessionMenuContent";
import { useDesktopShell } from "@/shell/provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function SessionItemMenu(props: SessionMenuProps) {
  const { t } = useTranslation();
  const slots = useMemo<SessionMenuSlots>(
    () => ({
      item: (key, children, onSelect) => (
        <DropdownMenuItem
          key={key}
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
          }}
        >
          {children}
        </DropdownMenuItem>
      ),
      separator: (key) => <DropdownMenuSeparator key={key} />,
      submenu: ({ key, trigger, children, contentClassName, ...subProps }) => (
        <DropdownMenuSub key={key} {...subProps}>
          <DropdownMenuSubTrigger>{trigger}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className={contentClassName}>{children}</DropdownMenuSubContent>
        </DropdownMenuSub>
      ),
    }),
    [],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={props.pinned ? t("sessionMenu.unpin") : t("sessionMenu.pin")}
          className="ml-auto opacity-0 group-hover/session:opacity-100 group-focus-within/session:opacity-100 transition-opacity shrink-0 size-6 rounded-md flex items-center justify-center hover:bg-accent"
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-64"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <SessionMenuContent {...props} slots={slots} focusTagInput />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ProjectMenuContentProps = {
  kind: "dropdown" | "context";
  pinned: boolean;
  collapsed: boolean;
  canCreateSession: boolean;
  onTogglePin: () => void;
  onNewSession: () => void;
  onToggleCollapsed: () => void;
  canRemove: boolean;
  onRemove: () => void;
  canCloseOtherProjects: boolean;
  onCloseOtherProjects: () => void;
  directory: string;
  isLocalWorkspace: boolean;
};

export function ProjectMenuContent({
  kind,
  pinned,
  collapsed,
  canCreateSession,
  onTogglePin,
  onNewSession,
  onToggleCollapsed,
  canRemove,
  onRemove,
  canCloseOtherProjects,
  onCloseOtherProjects,
  directory,
  isLocalWorkspace,
}: ProjectMenuContentProps) {
  const { t } = useTranslation();
  const shell = useDesktopShell();

  if (kind === "dropdown") {
    return (
      <>
        {canCreateSession && (
          <DropdownMenuItem
            onClick={(event) => {
              event.stopPropagation();
              onNewSession();
            }}
          >
            <SquarePen className="size-4" />
            <span>{t("projectMenu.newSession")}</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={(event) => {
            event.stopPropagation();
            onToggleCollapsed();
          }}
        >
          <Minimize2 className="size-4" />
          <span>
            {collapsed ? t("projectMenu.expandProject") : t("projectMenu.collapseProject")}
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={(event) => {
            event.stopPropagation();
            onTogglePin();
          }}
        >
          {pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          <span>{pinned ? t("projectMenu.unpinProject") : t("projectMenu.pinProject")}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={(event) => {
            event.stopPropagation();
            void copyTextToClipboard(directory);
          }}
        >
          <Copy className="size-4" />
          <span>{t("projectMenu.copyAbsolutePath")}</span>
        </DropdownMenuItem>
        {isLocalWorkspace && (
          <>
            <DropdownMenuItem
              onClick={(event) => {
                event.stopPropagation();
                void shell.system.openInFileBrowser(
                  directory,
                  storageGet(STORAGE_KEYS.FILE_MANAGER) ?? "",
                );
              }}
            >
              <FolderOpen className="size-4" />
              <span>{t("projectMenu.openInFileBrowser")}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(event) => {
                event.stopPropagation();
                void shell.system.openInTerminal(
                  directory,
                  storageGet(STORAGE_KEYS.TERMINAL) ?? "",
                );
              }}
            >
              <Terminal className="size-4" />
              <span>{t("projectMenu.openInTerminal")}</span>
            </DropdownMenuItem>
          </>
        )}
        {canRemove && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={(event) => {
                event.stopPropagation();
                onRemove();
              }}
            >
              <X className="size-4" />
              <span>{t("projectMenu.removeProject")}</span>
            </DropdownMenuItem>
            {canCloseOtherProjects && (
              <DropdownMenuItem
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseOtherProjects();
                }}
              >
                <X className="size-4" />
                <span>{t("projectMenu.closeOtherProjects")}</span>
              </DropdownMenuItem>
            )}
          </>
        )}
      </>
    );
  }

  return (
    <>
      {canCreateSession && (
        <ContextMenu.Item
          className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground"
          onClick={onNewSession}
        >
          <SquarePen className="size-4" />
          <span>{t("projectMenu.newSession")}</span>
        </ContextMenu.Item>
      )}
      <ContextMenu.Item
        className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground"
        onClick={onToggleCollapsed}
      >
        <Minimize2 className="size-4" />
        <span>{collapsed ? t("projectMenu.expandProject") : t("projectMenu.collapseProject")}</span>
      </ContextMenu.Item>
      <ContextMenu.Separator className="-mx-1 my-1 h-px bg-muted" />
      <ContextMenu.Item
        className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground"
        onClick={onTogglePin}
      >
        {pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
        <span>{pinned ? t("projectMenu.unpinProject") : t("projectMenu.pinProject")}</span>
      </ContextMenu.Item>
      <ContextMenu.Separator className="-mx-1 my-1 h-px bg-muted" />
      <ContextMenu.Item
        className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground"
        onClick={() => {
          void copyTextToClipboard(directory);
        }}
      >
        <Copy className="size-4" />
        <span>{t("projectMenu.copyAbsolutePath")}</span>
      </ContextMenu.Item>
      {isLocalWorkspace && (
        <>
          <ContextMenu.Item
            className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground"
            onClick={() => {
              void shell.system.openInFileBrowser(
                directory,
                storageGet(STORAGE_KEYS.FILE_MANAGER) ?? "",
              );
            }}
          >
            <FolderOpen className="size-4" />
            <span>{t("projectMenu.openInFileBrowser")}</span>
          </ContextMenu.Item>
          <ContextMenu.Item
            className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground"
            onClick={() => {
              void shell.system.openInTerminal(directory, storageGet(STORAGE_KEYS.TERMINAL) ?? "");
            }}
          >
            <Terminal className="size-4" />
            <span>{t("projectMenu.openInTerminal")}</span>
          </ContextMenu.Item>
        </>
      )}
      {canRemove && (
        <>
          <ContextMenu.Separator className="-mx-1 my-1 h-px bg-muted" />
          <ContextMenu.Item
            className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground"
            onClick={onRemove}
          >
            <X className="size-4" />
            <span>{t("projectMenu.removeProject")}</span>
          </ContextMenu.Item>
          {canCloseOtherProjects && (
            <ContextMenu.Item
              className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground"
              onClick={onCloseOtherProjects}
            >
              <X className="size-4" />
              <span>{t("projectMenu.closeOtherProjects")}</span>
            </ContextMenu.Item>
          )}
        </>
      )}
    </>
  );
}

export function ProjectItemMenu(props: Omit<ProjectMenuContentProps, "kind">) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={props.pinned ? t("projectMenu.unpinProject") : t("projectMenu.pinProject")}
          className="opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 transition-opacity shrink-0 size-6 rounded-md flex items-center justify-center hover:bg-accent group-data-[collapsible=icon]:hidden"
          data-project-action
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <ProjectMenuContent kind="dropdown" {...props} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
