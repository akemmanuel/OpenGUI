import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FolderOpen,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { useWorkspaceState } from "@/hooks/use-agent-state";
import { useIsMobile } from "@/hooks/use-mobile";
import { copyTextToClipboard } from "@/lib/browser";
import { STORAGE_KEYS } from "@/lib/constants";
import { hostBasename, hostParent, joinHostPath, relativeHostPath } from "@/lib/host-files";
import { notifyError } from "@/lib/notify";
import { storageGet } from "@/lib/persistence/storage";
import { cn } from "@/lib/utils";
import { useDesktopShell } from "@/shell/provider";
import {
  FILES_PANEL_DEFAULT_WIDTH_PX,
  FILES_PANEL_MAX_WIDTH_PX,
  FILES_PANEL_MIN_WIDTH_PX,
  clampFilesPanelWidth,
  useFilesPanel,
  type FilesPanelContextValue,
  type FilesPanelLocation,
} from "./files-panel-context";
import { FilePreview, previewStatus } from "./FilePreview";
import { FolderView } from "./FolderView";
import { useHostFileClient, type HostFileClient } from "./host-file-client";
import { PanelMessage, errorMessageKey } from "./PanelMessage";
import { useHostRequest } from "./use-host-request";

const MAX_CRUMBS = 3;

function Breadcrumb({
  root,
  location,
  onNavigate,
}: {
  root: string;
  location: FilesPanelLocation;
  onNavigate: (location: FilesPanelLocation) => void;
}) {
  const relative = relativeHostPath(root, location.path);
  const crumbs: { label: string; path: string }[] =
    relative === null
      ? [{ label: hostBasename(location.path), path: location.path }]
      : [
          { label: hostBasename(root), path: root },
          ...(relative ? relative.split("/") : []).map((segment, index, segments) => ({
            label: segment,
            path: joinHostPath(root, segments.slice(0, index + 1).join("/")),
          })),
        ];
  const shown = crumbs.slice(-MAX_CRUMBS);
  const hidden = crumbs.length > shown.length;

  return (
    <nav className="flex min-w-0 flex-1 items-center gap-1 text-sm" title={location.path}>
      {hidden && <span className="shrink-0 text-muted-foreground">…</span>}
      {shown.map((crumb, index) => {
        const last = index === shown.length - 1;
        return (
          <span
            key={crumb.path}
            className={cn("flex min-w-0 items-center gap-1", last && "shrink")}
          >
            {(index > 0 || hidden) && (
              <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground/70" />
            )}
            {last ? (
              <span
                className="min-w-0 truncate font-medium"
                aria-current="page"
                title={crumb.label}
              >
                {crumb.label}
              </span>
            ) : (
              <button
                type="button"
                className="min-w-0 max-w-28 truncate text-muted-foreground hover:text-foreground"
                title={crumb.label}
                onClick={() => onNavigate({ kind: "folder", path: crumb.path })}
              >
                {crumb.label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function HeaderButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="shrink-0 text-muted-foreground hover:text-foreground"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function FileView({
  panel,
  client,
  path,
  line,
  refreshKey,
  header,
}: {
  panel: FilesPanelContextValue;
  client: HostFileClient;
  path: string;
  line: number | null;
  refreshKey: string;
  header: (actions: React.ReactNode) => React.ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const { isLocalWorkspace, supportsNativeDirectoryPicker } = useWorkspaceState();
  const shell = useDesktopShell();
  const [copied, setCopied] = useState(false);
  const stat = useHostRequest(
    `${path}\n${refreshKey}`,
    (signal) => client.stat(path, signal),
    client,
  );
  const file = stat.status === "error" ? null : stat.data;

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const download = () => {
    if (!file) return;
    client.download(file.path, file.name).catch((error: unknown) => {
      notifyError(t("filesPanel.downloadFailed"), {
        description: error instanceof Error ? error.message : undefined,
      });
    });
  };

  const actions = (
    <>
      <HeaderButton label={t("filesPanel.download")} onClick={download} disabled={!file}>
        <Download />
      </HeaderButton>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label={t("filesPanel.more")} />}
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              void copyTextToClipboard(file?.path ?? path).then(() => setCopied(true));
            }}
          >
            {copied ? <Check /> : <Copy />}
            {copied ? t("filesPanel.pathCopied") : t("filesPanel.copyPath")}
          </DropdownMenuItem>
          {isLocalWorkspace && supportsNativeDirectoryPicker && (
            <DropdownMenuItem
              onClick={() => {
                void shell.system.openInFileBrowser(
                  hostParent(file?.path ?? path),
                  storageGet(STORAGE_KEYS.FILE_MANAGER) ?? "",
                );
              }}
            >
              <FolderOpen />
              {t("filesPanel.showInFolder")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => panel.setExpanded(!panel.expanded)}>
            {panel.expanded ? <Minimize2 /> : <Maximize2 />}
            {panel.expanded ? t("filesPanel.collapse") : t("filesPanel.expand")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  const status = file ? previewStatus(file, i18n.language, t) : null;
  return (
    <>
      {header(actions)}
      {stat.status === "error" ? (
        <PanelMessage>
          {t(errorMessageKey(stat.error.kind))}
          <Button variant="outline" size="sm" onClick={stat.retry}>
            {t("filesPanel.retry")}
          </Button>
        </PanelMessage>
      ) : !file ? (
        <PanelMessage>
          <Spinner className="size-4" />
        </PanelMessage>
      ) : (
        <FilePreview
          key={file.path}
          client={client}
          file={file}
          line={line}
          onDownload={download}
        />
      )}
      {status && (
        <div className="flex shrink-0 flex-wrap justify-between gap-x-3 border-t border-border px-3.5 py-1.5 text-xs text-muted-foreground">
          <span>{status.summary}</span>
          {status.note && <span>{status.note}</span>}
        </div>
      )}
    </>
  );
}

function ResizeHandle({ panel }: { panel: FilesPanelContextValue }) {
  const { t } = useTranslation();
  const dragRef = useRef<{
    startX: number;
    startWidth: number;
    aside: HTMLElement;
    handle: HTMLElement;
    pointerId: number;
  } | null>(null);
  const widthFor = (drag: NonNullable<typeof dragRef.current>, clientX: number) =>
    clampFilesPanelWidth(drag.startWidth - (clientX - drag.startX));

  useEffect(() => {
    const cancel = () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      delete drag.handle.dataset.dragging;
      drag.aside.style.width = `${panel.width}px`;
      document.body.style.removeProperty("cursor");
      if (drag.handle.hasPointerCapture(drag.pointerId))
        drag.handle.releasePointerCapture(drag.pointerId);
    };
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      cancel();
    };
  }, [panel.width]);

  return (
    // biome-ignore lint/a11y/useSemanticElements: A focusable separator is the ARIA pattern for resizable panes.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("filesPanel.resize")}
      aria-valuemin={FILES_PANEL_MIN_WIDTH_PX}
      aria-valuemax={FILES_PANEL_MAX_WIDTH_PX}
      aria-valuenow={panel.width}
      tabIndex={0}
      className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:transition-colors hover:after:bg-border focus-visible:after:bg-ring data-[dragging=true]:after:bg-ring"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      onPointerDown={(event) => {
        if (event.button !== 0 || dragRef.current) return;
        const aside = event.currentTarget.parentElement;
        if (!aside) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.dragging = "true";
        document.body.style.cursor = "col-resize";
        dragRef.current = {
          startX: event.clientX,
          startWidth: aside.getBoundingClientRect().width,
          aside,
          handle: event.currentTarget,
          pointerId: event.pointerId,
        };
        if (panel.expanded) panel.setExpanded(false);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        // Live width on the element; the setting is saved once on release.
        if (drag && drag.pointerId === event.pointerId)
          drag.aside.style.width = `${widthFor(drag, event.clientX)}px`;
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        dragRef.current = null;
        delete event.currentTarget.dataset.dragging;
        document.body.style.removeProperty("cursor");
        if (drag) panel.setWidth(widthFor(drag, event.clientX));
      }}
      onPointerCancel={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        dragRef.current.aside.style.width = `${panel.width}px`;
        dragRef.current = null;
        delete event.currentTarget.dataset.dragging;
        document.body.style.removeProperty("cursor");
      }}
      onLostPointerCapture={(event) => {
        if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
        dragRef.current.aside.style.width = `${panel.width}px`;
        dragRef.current = null;
        delete event.currentTarget.dataset.dragging;
        document.body.style.removeProperty("cursor");
      }}
      onDoubleClick={() => panel.setWidth(FILES_PANEL_DEFAULT_WIDTH_PX)}
      onKeyDown={(event) => {
        // The panel sits on the right, so ArrowLeft makes it wider.
        if (event.key === "ArrowLeft") panel.setWidth(panel.width + 24);
        else if (event.key === "ArrowRight") panel.setWidth(panel.width - 24);
        else return;
        event.preventDefault();
      }}
    />
  );
}

/** Right-hand file browser for the active chat's project. */
export function FilesPanel() {
  const { t } = useTranslation();
  const panel = useFilesPanel();
  const client = useHostFileClient();
  const isMobile = useIsMobile();

  // Refresh the open folder or file when the agent writes something.
  const refreshKey = useMemo(
    () => panel?.chatFiles.map((file) => `${file.path}:${file.time ?? ""}`).join("|") ?? "",
    [panel?.chatFiles],
  );

  if (!panel?.open || !panel.root || !client) return null;
  const root = panel.root;
  const location: FilesPanelLocation = panel.location ?? { kind: "folder", path: root };

  const header = (actions?: React.ReactNode) => (
    <div className="flex h-11 shrink-0 items-center gap-0.5 border-b border-border px-1.5">
      <HeaderButton label={t("filesPanel.back")} onClick={panel.back} disabled={!panel.canGoBack}>
        <ChevronLeft />
      </HeaderButton>
      <HeaderButton
        label={t("filesPanel.forward")}
        onClick={panel.forward}
        disabled={!panel.canGoForward}
      >
        <ChevronRight />
      </HeaderButton>
      <div className="ml-1 flex min-w-0 flex-1">
        <Breadcrumb root={root} location={location} onNavigate={panel.navigate} />
      </div>
      {actions}
      <HeaderButton label={t("filesPanel.close")} onClick={() => panel.setOpen(false)}>
        <X />
      </HeaderButton>
    </div>
  );

  const content =
    location.kind === "file" ? (
      <FileView
        key={location.path}
        panel={panel}
        client={client}
        path={location.path}
        line={location.line}
        refreshKey={refreshKey}
        header={header}
      />
    ) : (
      <>
        {header()}
        <FolderView
          key={location.path}
          client={client}
          root={root}
          path={location.path}
          chatFiles={panel.chatFiles}
          refreshKey={refreshKey}
          onNavigate={panel.navigate}
        />
      </>
    );

  if (isMobile) {
    return (
      <Sheet open onOpenChange={panel.setOpen}>
        <SheetContent
          side="right"
          showCloseButton={false}
          aria-describedby={undefined}
          className="w-full! max-w-md! gap-0 bg-sidebar pt-[var(--app-safe-top)] pb-[var(--app-safe-bottom)] text-sidebar-foreground"
        >
          <SheetTitle className="sr-only">{t("filesPanel.title")}</SheetTitle>
          {content}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside
      aria-label={t("filesPanel.title")}
      className="relative flex h-full max-w-[70vw] shrink-0 flex-col border-l border-border bg-sidebar text-sidebar-foreground"
      style={{ width: panel.expanded ? "60vw" : panel.width }}
    >
      <ResizeHandle panel={panel} />
      {content}
    </aside>
  );
}
