import { ChevronDown, ChevronLeft, Folder, FolderOpen, Pencil, Search, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { notifyUnknownError } from "@/lib/notify";
import { useTranslation } from "react-i18next";
import { i18n } from "@/i18n";
import { DialogShell } from "@/components/ui/DialogShell";
import { Button } from "@/components/ui/button";
import { useWorkspaceState } from "@/hooks/use-agent-state";
import { canManageProjects as resolveCanManageProjects } from "@/hooks/workspace-guards";
import { notifyInfo } from "@/lib/notify";
import { getProjectName, normalizeProjectPath } from "@/lib/path";
import { useDesktopShell } from "@/shell/provider";
import { DEFAULT_SERVER_URL } from "@/lib/constants";

interface OpenProjectPathDialogDetail {
  resolve: (value: string | null) => void;
  initialPath?: string;
  purpose?: "project" | "default";
}

export function requestProjectPath(
  initialPath?: string,
  purpose?: OpenProjectPathDialogDetail["purpose"],
) {
  return new Promise<string | null>((resolve) => {
    window.dispatchEvent(
      new CustomEvent("opengui:open-project-path-dialog", {
        detail: { resolve, initialPath, purpose } satisfies OpenProjectPathDialogDetail,
      }),
    );
  });
}

interface ServerDirectoryEntry {
  name: string;
  path: string;
  type: "dir";
}

interface ServerDirectoryListing {
  path: string;
  parent: string | null;
  roots: string[];
  entries: ServerDirectoryEntry[];
}

interface ApiResponse<T> {
  ok?: boolean;
  value?: T;
  error?: string;
}

function isWebRuntime() {
  return !navigator.userAgent.includes("Electron");
}

function isLoopbackServerUrl(url: string) {
  try {
    const parsed = new URL(url);
    return ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function resolveBrowserApiBaseUrl(workspaceServerUrl: string | null | undefined) {
  if (!isWebRuntime()) return workspaceServerUrl ?? DEFAULT_SERVER_URL;
  if (!workspaceServerUrl || isLoopbackServerUrl(workspaceServerUrl)) return window.location.origin;
  return workspaceServerUrl;
}

export function ProjectPathDialog() {
  const { t } = useTranslation();
  const {
    activeWorkspace,
    activeWorkspaceId,
    workspaces,
    workspaceServerUrl,
    workspaceDirectory,
    supportsNativeDirectoryPicker,
  } = useWorkspaceState();
  const shell = useDesktopShell();
  const [open, setOpen] = useState(false);
  const [purpose, setPurpose] = useState<OpenProjectPathDialogDetail["purpose"]>();
  const [value, setValue] = useState("");
  const [serverListing, setServerListing] = useState<ServerDirectoryListing | null>(null);
  const [serverBrowserLoading, setServerBrowserLoading] = useState(false);
  const [folderSearch, setFolderSearch] = useState("");
  const [pathEditing, setPathEditing] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [pathError, setPathError] = useState(false);
  const pathErrorId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const resolverRef = useRef<((value: string | null) => void) | null>(null);
  const serverBrowseInitialPathRef = useRef<string | undefined>(undefined);
  const useServerBrowser = !supportsNativeDirectoryPicker;

  const loadServerDirectory = useCallback(
    async (path?: string, reportError = true) => {
      const resolve = resolverRef.current;
      setServerBrowserLoading(true);
      try {
        const params = new URLSearchParams();
        if (path) params.set("path", path);
        const baseUrl = resolveBrowserApiBaseUrl(workspaceServerUrl).replace(/\/+$/, "");
        const headers = new Headers();
        if (activeWorkspace?.authToken) {
          headers.set("authorization", `Bearer ${activeWorkspace.authToken}`);
        }
        const response = await fetch(`${baseUrl}/api/fs/list?${params.toString()}`, { headers });
        const responseText = await response.text();
        let body: ApiResponse<ServerDirectoryListing> | null = null;
        try {
          body = responseText
            ? (JSON.parse(responseText) as ApiResponse<ServerDirectoryListing>)
            : null;
        } catch {
          body = null;
        }
        if (response.status === 404) {
          throw new Error(
            body?.error?.includes("API-only")
              ? "This OpenGUI backend does not provide server folder browsing. Update or restart the backend, or paste the project path manually."
              : "Server folder browsing is not available on this OpenGUI backend. Update or restart the backend, or paste the project path manually.",
          );
        }
        if (!response.ok || !body?.ok || !body.value)
          throw new Error(body?.error || "Failed to list server folders");
        if (resolverRef.current !== resolve) return null;
        setServerListing(body.value);
        setValue(body.value.path);
        return body.value.path;
      } catch (error) {
        if (reportError && resolverRef.current === resolve) notifyUnknownError(error);
        return null;
      } finally {
        if (resolverRef.current === resolve) setServerBrowserLoading(false);
      }
    },
    [activeWorkspace?.authToken, workspaceServerUrl],
  );

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const customEvent = event as CustomEvent<OpenProjectPathDialogDetail>;
      if (!resolveCanManageProjects(workspaces, activeWorkspaceId, activeWorkspace)) {
        notifyInfo(i18n.t("workspace.requiredBeforeProject"));
        customEvent.detail.resolve(null);
        return;
      }
      resolverRef.current?.(null);
      resolverRef.current = customEvent.detail.resolve;
      setPurpose(customEvent.detail.purpose);
      const initial = customEvent.detail.initialPath ?? workspaceDirectory ?? "";
      setValue(initial);
      const trimmed = initial.trim();
      serverBrowseInitialPathRef.current = trimmed || undefined;
      setServerListing(null);
      setServerBrowserLoading(false);
      setFolderSearch("");
      setPathEditing(false);
      setPathError(false);
      setOpen(true);
    };

    window.addEventListener("opengui:open-project-path-dialog", handleOpen as EventListener);
    return () => {
      window.removeEventListener("opengui:open-project-path-dialog", handleOpen as EventListener);
      resolverRef.current?.(null);
      resolverRef.current = null;
    };
  }, [activeWorkspace, activeWorkspaceId, workspaceDirectory, workspaces]);

  useEffect(() => {
    if (!open || !useServerBrowser) return;
    void loadServerDirectory(serverBrowseInitialPathRef.current);
  }, [open, useServerBrowser, loadServerDirectory]);

  const closeWith = (nextValue: string | null) => {
    const normalizedValue = nextValue ? normalizeProjectPath(nextValue) : null;
    resolverRef.current?.(normalizedValue);
    resolverRef.current = null;
    setServerListing(null);
    setServerBrowserLoading(false);
    setOpen(false);
  };

  const selectServerDirectory = (path: string) => {
    setFolderSearch("");
    setPathEditing(false);
    setValue(path);
    void loadServerDirectory(path);
  };

  async function applyManualPath(confirm: boolean) {
    const resolve = resolverRef.current;
    const path = pathDraft.trim();
    if (!path || serverBrowserLoading) return;
    const validated = await loadServerDirectory(path, false);
    if (resolverRef.current !== resolve) return;
    if (!validated) {
      setPathError(true);
      return;
    }
    setPathEditing(false);
    setFolderSearch("");
    if (confirm) closeWith(validated);
  }

  const visibleEntries = serverListing?.entries.filter((entry) =>
    entry.name.toLocaleLowerCase().includes(folderSearch.trim().toLocaleLowerCase()),
  );

  const browseNative = async () => {
    const nextPath = await shell.dialog.openDirectory();
    if (nextPath) setValue(nextPath);
  };

  const defaultFolder = purpose === "default";
  const confirmationLabel = t(defaultFolder ? "projectPath.useFolder" : "projectPath.openProject");
  const selectedPath = pathEditing ? pathDraft.trim() : value.trim();
  const relativeParts = normalizeProjectPath(selectedPath).split("/").filter(Boolean);
  const confirmPath =
    relativeParts.length > 2 ? `…/${relativeParts.slice(-2).join("/")}` : selectedPath;

  return (
    <DialogShell
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeWith(null);
      }}
      className={
        useServerBrowser
          ? "h-[min(34rem,calc(100dvh-1rem))] max-w-[calc(100vw-1rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-3 overflow-hidden p-4 sm:max-w-2xl"
          : "max-w-[calc(100vw-1rem)] gap-3 p-4 sm:max-w-2xl"
      }
      title={t(defaultFolder ? "projectPath.defaultTitle" : "projectPath.title")}
      bodyClassName="flex min-h-0 flex-col"
      footerClassName="-mx-4 -mb-4 p-3"
      footer={
        <>
          {(!useServerBrowser || pathEditing) && selectedPath && (
            <div className="mr-auto w-full min-w-0 font-mono text-xs font-medium text-foreground max-sm:order-last sm:w-auto sm:flex-1">
              {relativeParts.length > 2 ? (
                <details>
                  <summary
                    className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded focus-visible:outline-2 focus-visible:outline-ring sm:min-h-8"
                    title={selectedPath}
                  >
                    <span
                      className="min-w-0 truncate [direction:rtl] [text-align:left]"
                      data-responsive-allow="text-clip"
                    >
                      <bdi dir="ltr">{confirmPath}</bdi>
                    </span>
                    <ChevronDown className="size-3 shrink-0" aria-hidden />
                  </summary>
                  <p className="mt-1.5 max-h-[min(5rem,18dvh)] overflow-y-auto break-all text-muted-foreground">
                    {selectedPath}
                  </p>
                </details>
              ) : (
                confirmPath
              )}
            </div>
          )}
          <Button type="button" variant="ghost" onClick={() => closeWith(null)}>
            {t("common.cancel")}
          </Button>
          {useServerBrowser ? (
            <Button
              type="button"
              disabled={!selectedPath || serverBrowserLoading}
              onClick={() => (pathEditing ? void applyManualPath(true) : closeWith(selectedPath))}
            >
              {confirmationLabel}
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => void browseNative()}>
                <FolderOpen className="size-4" />
                {t("common.browse")}
              </Button>
              <Button
                type="button"
                disabled={!value.trim() || serverBrowserLoading}
                onClick={() => closeWith(value)}
              >
                {confirmationLabel}
              </Button>
            </>
          )}
        </>
      }
    >
      {useServerBrowser ? (
        <div className="flex min-h-0 flex-1 flex-col rounded-lg border bg-background/40 p-2">
          <div className="mb-2 flex min-w-0 items-center gap-2 border-b pb-2">
            {pathEditing ? (
              <div className="flex min-w-0 flex-1 flex-col gap-1 rounded px-1 py-1 focus-within:ring-2 focus-within:ring-ring">
                <span className="truncate text-xs font-medium" title={serverListing?.path}>
                  {getProjectName(serverListing?.path ?? "", "")}
                </span>
                <input
                  aria-label={t("projectPath.projectPathLabel")}
                  aria-invalid={pathError}
                  aria-describedby={pathError ? pathErrorId : undefined}
                  className="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-sm outline-none"
                  value={pathDraft}
                  readOnly={serverBrowserLoading}
                  onChange={(event) => {
                    setPathDraft(event.target.value);
                    setPathError(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && pathDraft.trim()) {
                      event.preventDefault();
                      void applyManualPath(false);
                    } else if (event.key === "Escape" && !serverBrowserLoading) {
                      event.stopPropagation();
                      setPathEditing(false);
                    }
                  }}
                  autoComplete="off"
                  autoFocus
                />
              </div>
            ) : serverListing?.path ? (
              <button
                type="button"
                className="group flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  setPathDraft(serverListing.path);
                  setPathError(false);
                  setPathEditing(true);
                }}
                title={t("projectPath.editPath")}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2.5">
                  <FolderOpen className="size-5 shrink-0 text-primary" aria-hidden="true" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-semibold" title={serverListing.path}>
                      {getProjectName(serverListing.path, serverListing.path)}
                    </span>
                    <span
                      className="truncate font-mono text-xs text-muted-foreground"
                      title={serverListing.path}
                    >
                      {serverListing.path}
                    </span>
                  </span>
                </span>
                <Pencil className="size-3.5 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100" />
              </button>
            ) : (
              <span className="text-xs text-muted-foreground sm:text-sm">
                {t("projectPath.loadingServerFolders")}
              </span>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={!serverListing?.parent || serverBrowserLoading}
              onClick={() => serverListing?.parent && selectServerDirectory(serverListing.parent)}
            >
              <ChevronLeft className="size-4" />
              <span className="max-sm:sr-only">{t("projectPath.up")}</span>
            </Button>
          </div>
          {pathEditing && pathError && (
            <p id={pathErrorId} role="alert" className="mb-2 px-1 text-xs text-destructive">
              {t("projectPath.unavailableFolder")}
            </p>
          )}
          <label className="relative mb-1.5 block">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <span className="sr-only">{t("projectPath.searchFolders")}</span>
            <input
              ref={searchRef}
              type="search"
              value={folderSearch}
              onChange={(event) => setFolderSearch(event.target.value)}
              placeholder={t("projectPath.searchFolders")}
              className="h-12 w-full rounded-md border bg-background pr-12 pl-9 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/25 md:h-9 md:pr-9 [&::-webkit-search-cancel-button]:appearance-none"
            />
            {folderSearch && (
              <button
                type="button"
                onClick={() => {
                  setFolderSearch("");
                  searchRef.current?.focus();
                }}
                className="absolute top-1/2 right-0.5 flex size-11 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:right-1.5 md:size-7"
                aria-label={t("projectPath.clearSearch")}
              >
                <X className="size-4" />
              </button>
            )}
          </label>
          <div className="min-h-0 flex-1 overflow-y-auto rounded-md border bg-background">
            {serverBrowserLoading ? (
              <div className="px-3 py-3 text-sm text-muted-foreground">{t("common.loading")}</div>
            ) : visibleEntries?.length ? (
              visibleEntries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className="flex min-h-9 w-full items-center gap-2.5 border-b px-3 text-left text-sm transition-colors last:border-b-0 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  onClick={() => selectServerDirectory(entry.path)}
                  onDoubleClick={() => closeWith(entry.path)}
                >
                  <Folder className="size-[18px] shrink-0 text-muted-foreground" />
                  <span className="truncate">{entry.name}</span>
                </button>
              ))
            ) : (
              <div className="flex h-full min-h-32 items-center justify-center px-4 text-center text-sm text-muted-foreground">
                {folderSearch ? t("projectPath.noMatchingFolders") : t("projectPath.noFolders")}
              </div>
            )}
          </div>
        </div>
      ) : (
        <label className="block space-y-1.5 text-sm font-medium">
          <span>{t("projectPath.projectPathLabel")}</span>
          <input
            className="h-10 w-full rounded-md border bg-background px-3 font-mono text-sm font-normal outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/25"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
          />
        </label>
      )}
    </DialogShell>
  );
}
