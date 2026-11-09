import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  hostBasename,
  joinHostPath,
  relativeHostPath,
  type ChatFile,
  type ChatFileChange,
} from "@/lib/host-files";
import { cn } from "@/lib/utils";
import { FileIcon } from "./FileIcon";
import { FileContextMenu } from "./FileContextMenu";
import type { FilesPanelLocation } from "./files-panel-context";
import { formatFileDate } from "./format";
import type { HostFileClient } from "./host-file-client";
import { PanelMessage, errorMessageKey } from "./PanelMessage";
import { useHostRequest } from "./use-host-request";

const pathKey = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");

function ChangeDot({ change }: { change: ChatFileChange | undefined }) {
  const { t } = useTranslation();
  if (!change) return <span aria-hidden className="size-1.5 shrink-0" />;
  const label = t(change === "created" ? "filesPanel.created" : "filesPanel.changed");
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        change === "created" ? "bg-emerald-500" : "bg-amber-500",
      )}
    />
  );
}

function Row({
  path,
  name,
  detail,
  folder,
  change,
  trailing,
  onOpen,
}: {
  path: string;
  name: string;
  detail?: string | null;
  folder?: boolean;
  change?: ChatFileChange;
  trailing?: string | null;
  onOpen: () => void;
}) {
  return (
    <li>
      <FileContextMenu path={path} folder={folder} onOpen={onOpen}>
        <button
          type="button"
          className="flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
          title={detail ? `${detail}/${name}` : name}
          onClick={onOpen}
        >
          <FileIcon name={name} folder={folder} />
          <span className="min-w-0 flex-1 truncate">
            {name}
            {detail ? <span className="text-xs text-muted-foreground"> {detail}</span> : null}
          </span>
          <ChangeDot change={change} />
          {trailing !== undefined && (
            <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
              {trailing}
            </span>
          )}
        </button>
      </FileContextMenu>
    </li>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pt-3 pb-1 text-xs font-medium text-muted-foreground">{children}</div>
  );
}

export function FolderView({
  client,
  root,
  path,
  chatFiles,
  refreshKey,
  onNavigate,
}: {
  client: HostFileClient;
  root: string;
  path: string;
  chatFiles: ChatFile[];
  refreshKey: string;
  onNavigate: (location: FilesPanelLocation) => void;
}) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const isRoot = pathKey(path) === pathKey(root);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  const changes = useMemo(
    () => new Map(chatFiles.map((file) => [pathKey(file.path), file.change])),
    [chatFiles],
  );

  const listing = useHostRequest(
    `${path}\n${refreshKey}`,
    (signal) => client.list(path, signal),
    client,
  );
  const search = useHostRequest(
    `${root}\n${debouncedQuery}`,
    debouncedQuery ? (signal) => client.search(root, debouncedQuery, signal) : null,
    client,
  );

  const relativeDetail = (absolute: string) => {
    const relative = relativeHostPath(root, absolute);
    if (relative === null) return absolute;
    const slash = relative.lastIndexOf("/");
    return slash > 0 ? relative.slice(0, slash) : null;
  };

  let body: React.ReactNode;
  let status: string | null = null;
  if (debouncedQuery) {
    const results = search.data ?? [];
    if (search.status === "error") {
      body = (
        <PanelMessage>
          {t(errorMessageKey(search.error.kind))}
          <Button variant="outline" size="sm" onClick={search.retry}>
            {t("filesPanel.retry")}
          </Button>
        </PanelMessage>
      );
    } else if (search.status === "loading" && !search.data) {
      body = (
        <PanelMessage>
          <Spinner className="size-4" />
        </PanelMessage>
      );
    } else if (results.length === 0) {
      body = <PanelMessage>{t("filesPanel.noResults", { query: debouncedQuery })}</PanelMessage>;
    } else {
      body = (
        <>
          <GroupLabel>
            {t("filesPanel.results", { count: results.length, folder: hostBasename(root) })}
          </GroupLabel>
          <ul>
            {results.map((result) => {
              const folder = result.endsWith("/");
              const relative = result.replace(/\/$/, "");
              const absolute = joinHostPath(root, relative);
              const slash = relative.lastIndexOf("/");
              return (
                <Row
                  key={result}
                  path={absolute}
                  name={relative.slice(slash + 1)}
                  detail={slash > 0 ? relative.slice(0, slash) : null}
                  folder={folder}
                  change={changes.get(pathKey(absolute))}
                  onOpen={() =>
                    onNavigate(
                      folder
                        ? { kind: "folder", path: absolute }
                        : { kind: "file", path: absolute, line: null },
                    )
                  }
                />
              );
            })}
          </ul>
        </>
      );
    }
  } else if (listing.status === "error") {
    body = (
      <PanelMessage>
        {t(errorMessageKey(listing.error.kind, "folder"))}
        <Button variant="outline" size="sm" onClick={listing.retry}>
          {t("filesPanel.retry")}
        </Button>
      </PanelMessage>
    );
  } else if (!listing.data) {
    body = (
      <PanelMessage>
        <Spinner className="size-4" />
      </PanelMessage>
    );
  } else {
    const entries = listing.data.entries;
    status = t("filesPanel.items", { count: entries.length });
    body = (
      <>
        {isRoot && chatFiles.length > 0 && (
          <>
            <GroupLabel>{t("filesPanel.inThisChat")}</GroupLabel>
            <ul>
              {chatFiles.map((file) => (
                <Row
                  key={file.path}
                  path={file.path}
                  name={hostBasename(file.path)}
                  detail={relativeDetail(file.path)}
                  change={file.change}
                  trailing={file.time ? formatFileDate(file.time, i18n.language) : ""}
                  onOpen={() => onNavigate({ kind: "file", path: file.path, line: null })}
                />
              ))}
            </ul>
            <GroupLabel>{hostBasename(root)}</GroupLabel>
          </>
        )}
        {entries.length === 0 ? (
          <PanelMessage>{t("filesPanel.emptyFolder")}</PanelMessage>
        ) : (
          <ul>
            {entries.map((entry) => (
              <Row
                key={entry.path}
                path={entry.path}
                name={entry.name}
                folder={entry.type === "dir"}
                change={changes.get(pathKey(entry.path))}
                trailing={entry.modifiedAt ? formatFileDate(entry.modifiedAt, i18n.language) : ""}
                onOpen={() =>
                  onNavigate(
                    entry.type === "dir"
                      ? { kind: "folder", path: entry.path }
                      : { kind: "file", path: entry.path, line: null },
                  )
                }
              />
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2.5 pt-2 pb-1">
        <div className="flex h-8 items-center gap-2 rounded-md border border-input bg-background/60 px-2.5 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
          <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.stopPropagation();
                setQuery("");
              }
            }}
            placeholder={t("filesPanel.search")}
            aria-label={t("filesPanel.search")}
            className="min-w-0 flex-1 bg-transparent text-base md:text-sm outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              className="rounded-sm text-muted-foreground hover:text-foreground"
              aria-label={t("filesPanel.clearSearch")}
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">{body}</div>
      {status && (
        <div className="flex shrink-0 justify-between gap-3 border-t border-border px-3.5 py-1.5 text-xs text-muted-foreground">
          <span>{status}</span>
          <span className="truncate" title={path}>
            {path}
          </span>
        </div>
      )}
    </div>
  );
}
