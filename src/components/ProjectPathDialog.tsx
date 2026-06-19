import { ChevronLeft, Folder, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MOBILE_BACK_PRIORITY } from "@/shell/mobile-back-handler";
import { useRegisterMobileBackHandler } from "@/shell/useRegisterMobileBackHandler";
import { notifyUnknownError } from "@/lib/notify";
import { useTranslation } from "react-i18next";
import { i18n } from "@/i18n";
import { DialogShell } from "@/components/ui/DialogShell";
import { Button } from "@/components/ui/button";
import { useConnectionState } from "@/hooks/use-agent-state";
import { canManageProjects as resolveCanManageProjects } from "@/hooks/workspace-guards";
import { notifyInfo } from "@/lib/notify";
import { normalizeProjectPath } from "@/lib/utils";
import { useDesktopShell } from "@/shell/provider";
import { DEFAULT_SERVER_URL } from "@/lib/constants";

interface OpenProjectPathDialogDetail {
  resolve: (value: string | null) => void;
  initialPath?: string;
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

function PathLine({ path }: { path: string }) {
  return (
    <div className="min-w-0 w-full overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch]">
      <span
        className="block w-max max-w-none font-mono text-xs leading-snug whitespace-nowrap sm:text-sm"
        title={path}
      >
        {path}
      </span>
    </div>
  );
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
  } = useConnectionState();
  const shell = useDesktopShell();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [serverListing, setServerListing] = useState<ServerDirectoryListing | null>(null);
  const [serverBrowserLoading, setServerBrowserLoading] = useState(false);
  const resolverRef = useRef<((value: string | null) => void) | null>(null);
  const serverBrowseInitialPathRef = useRef<string | undefined>(undefined);
  const useServerBrowser = !supportsNativeDirectoryPicker;

  const loadServerDirectory = useCallback(
    async (path?: string) => {
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
        setServerListing(body.value);
        setValue(body.value.path);
      } catch (error) {
        notifyUnknownError(error);
      } finally {
        setServerBrowserLoading(false);
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
      const initial = customEvent.detail.initialPath ?? workspaceDirectory ?? "";
      setValue(initial);
      const trimmed = initial.trim();
      serverBrowseInitialPathRef.current = trimmed || undefined;
      setServerListing(null);
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
    setOpen(false);
  };

  const handleMobileBackProjectPath = useCallback(() => {
    resolverRef.current?.(null);
    resolverRef.current = null;
    setServerListing(null);
    setOpen(false);
    return true;
  }, []);
  useRegisterMobileBackHandler(
    MOBILE_BACK_PRIORITY.PROJECT_PATH,
    open,
    handleMobileBackProjectPath,
  );

  const selectServerDirectory = (path: string) => {
    setValue(path);
    void loadServerDirectory(path);
  };

  const browseNative = async () => {
    const nextPath = await shell.dialog.openDirectory();
    if (nextPath) setValue(nextPath);
  };

  return (
    <DialogShell
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeWith(null);
      }}
      className="max-w-[min(32rem,calc(100vw-2rem))] sm:max-w-lg"
      title={t("projectPath.title")}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={() => closeWith(null)}>
            {t("common.cancel")}
          </Button>
          {useServerBrowser ? (
            <Button type="button" disabled={!value.trim()} onClick={() => closeWith(value)}>
              {t("projectPath.openProject")}
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => void browseNative()}>
                <FolderOpen className="size-4" />
                {t("common.browse")}
              </Button>
              <Button type="button" disabled={!value.trim()} onClick={() => closeWith(value)}>
                {t("projectPath.openProject")}
              </Button>
            </>
          )}
        </>
      }
    >
      {useServerBrowser ? (
        <div className="min-w-0 rounded-lg border p-2">
          <div className="mb-2 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            {serverListing?.path ? (
              <PathLine path={serverListing.path} />
            ) : (
              <span className="text-xs text-muted-foreground sm:text-sm">
                {t("projectPath.loadingServerFolders")}
              </span>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 self-end sm:self-auto"
              disabled={!serverListing?.parent || serverBrowserLoading}
              onClick={() => serverListing?.parent && selectServerDirectory(serverListing.parent)}
            >
              <ChevronLeft className="size-4" />
              <span className="max-sm:sr-only">{t("projectPath.up")}</span>
            </Button>
          </div>
          <div className="max-h-64 overflow-y-auto rounded border bg-background">
            {serverBrowserLoading ? (
              <div className="px-3 py-2 text-sm">{t("common.loading")}</div>
            ) : serverListing?.entries.length ? (
              serverListing.entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                  onClick={() => selectServerDirectory(entry.path)}
                  onDoubleClick={() => closeWith(entry.path)}
                >
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{entry.name}</span>
                </button>
              ))
            ) : (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                {t("projectPath.noFolders")}
              </div>
            )}
          </div>
        </div>
      ) : value.trim() ? (
        <PathLine path={value} />
      ) : null}
    </DialogShell>
  );
}
