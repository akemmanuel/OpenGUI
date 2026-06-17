import { ChevronLeft, Folder, FolderOpen, Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { notifyUnknownError } from "@/lib/notify";
import { useTranslation } from "react-i18next";
import { DialogShell } from "@/components/ui/DialogShell";
import { FormField } from "@/components/ui/FormField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConnectionState } from "@/hooks/use-agent-state";
import { DEFAULT_SERVER_URL } from "@/lib/constants";
import { normalizeProjectPath } from "@/lib/utils";
import { useDesktopShell } from "@/shell/provider";

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

export function ProjectPathDialog() {
  const { t } = useTranslation();
  const {
    activeWorkspace,
    isLocalWorkspace,
    workspaceServerUrl,
    workspaceDirectory,
    supportsNativeDirectoryPicker,
  } = useConnectionState();
  const shell = useDesktopShell();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [showServerBrowser, setShowServerBrowser] = useState(false);
  const [serverListing, setServerListing] = useState<ServerDirectoryListing | null>(null);
  const [serverBrowserLoading, setServerBrowserLoading] = useState(false);
  const resolverRef = useRef<((value: string | null) => void) | null>(null);
  const webRuntime = isWebRuntime();

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const customEvent = event as CustomEvent<OpenProjectPathDialogDetail>;
      resolverRef.current?.(null);
      resolverRef.current = customEvent.detail.resolve;
      setValue(customEvent.detail.initialPath ?? workspaceDirectory ?? "");
      setShowServerBrowser(false);
      setOpen(true);
    };

    window.addEventListener("opengui:open-project-path-dialog", handleOpen as EventListener);
    return () => {
      window.removeEventListener("opengui:open-project-path-dialog", handleOpen as EventListener);
      resolverRef.current?.(null);
      resolverRef.current = null;
    };
  }, [workspaceDirectory]);

  const closeWith = (nextValue: string | null) => {
    const normalizedValue = nextValue ? normalizeProjectPath(nextValue) : null;
    resolverRef.current?.(normalizedValue);
    resolverRef.current = null;
    setShowServerBrowser(false);
    setOpen(false);
  };

  const loadServerDirectory = async (path?: string) => {
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
  };

  const openServerBrowser = () => {
    setShowServerBrowser(true);
    void loadServerDirectory(value.trim() || undefined);
  };

  const selectServerDirectory = (path: string) => {
    setValue(path);
    void loadServerDirectory(path);
  };

  return (
    <DialogShell
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeWith(null);
      }}
      className="sm:max-w-lg"
      title={t("projectPath.title")}
      description={
        webRuntime && isLocalWorkspace
          ? t("projectPath.webLocalDescription")
          : isLocalWorkspace
            ? t("projectPath.localDescription")
            : t("projectPath.remoteDescription")
      }
      footer={
        <>
          <Button type="button" variant="ghost" onClick={() => closeWith(null)}>
            {t("common.cancel")}
          </Button>
          <Button type="button" disabled={!value.trim()} onClick={() => closeWith(value)}>
            {t("projectPath.openProject")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <Server className="size-3.5 shrink-0" />
            <span className="font-mono">{workspaceServerUrl ?? DEFAULT_SERVER_URL}</span>
          </div>
        </div>

        <FormField label={t("projectPath.projectPathLabel")} htmlFor="project-path">
          <div className="flex gap-2">
            <Input
              id="project-path"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={
                isLocalWorkspace ? "/absolute/path/to/project" : "/remote/path/to/project"
              }
              className="font-mono text-sm"
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Enter" && value.trim()) {
                  event.preventDefault();
                  closeWith(value);
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={async () => {
                if (!supportsNativeDirectoryPicker) {
                  openServerBrowser();
                  return;
                }
                const nextPath = await shell.dialog.openDirectory();
                if (nextPath) setValue(nextPath);
              }}
            >
              <FolderOpen className="size-4" />
              {supportsNativeDirectoryPicker ? t("common.browse") : t("projectPath.browseServer")}
            </Button>
          </div>
          {showServerBrowser && (
            <div className="rounded-lg border bg-muted/20 p-2">
              <div className="mb-2 flex items-center justify-between gap-2 text-xs">
                <span className="truncate font-mono text-muted-foreground">
                  {serverListing?.path ?? t("projectPath.loadingServerFolders")}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!serverListing?.parent || serverBrowserLoading}
                  onClick={() =>
                    serverListing?.parent && selectServerDirectory(serverListing.parent)
                  }
                >
                  <ChevronLeft className="size-4" />
                  {t("projectPath.up")}
                </Button>
              </div>
              <div className="max-h-56 overflow-y-auto rounded border bg-background">
                {serverBrowserLoading ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground">
                    {t("common.loading")}
                  </div>
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
                  <div className="px-3 py-2 text-xs text-muted-foreground">
                    {t("projectPath.noFolders")}
                  </div>
                )}
              </div>
              <div className="mt-2 text-[11px] text-muted-foreground">
                {t("projectPath.allowedRoots", {
                  roots: serverListing?.roots.join(", ") || t("projectPath.serverDefault"),
                })}
              </div>
            </div>
          )}
        </FormField>
      </div>
    </DialogShell>
  );
}
