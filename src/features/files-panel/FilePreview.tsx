import { Download } from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { HostImage } from "@/components/HostImage";
import { MarkdownImageContext, MarkdownRenderer } from "@/components/MarkdownRenderer";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useWorkspaceState } from "@/hooks/use-agent-state";
import { resolveAttachmentImageSrc } from "@/lib/attachment-src";
import {
  fileExtension,
  HIGHLIGHT_MAX_CHARS,
  hostParent,
  isolateHtmlDocument,
  previewKindFor,
  TEXT_PREVIEW_MAX_BYTES,
} from "@/lib/host-files";
import { cn } from "@/lib/utils";
import { csvPreview } from "./csv";
import { FileIcon } from "./FileIcon";
import { formatFileDate, formatFileSize } from "./format";
import type { HostFileClient, HostFileInfo } from "./host-file-client";
import { inlineLocalHtmlResources } from "./html-resources";
import { PanelMessage, errorMessageKey } from "./PanelMessage";
import { useHostRequest } from "./use-host-request";

const PdfPreview = lazy(() => import("./PdfPreview"));

const LINE_HEIGHT_PX = 20;

function CodeView({ text, name, line }: { text: string; name: string; line: number | null }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [highlighted, setHighlighted] = useState<React.ReactNode>(null);
  const lineCount = useMemo(() => text.split("\n").length, [text]);

  useEffect(() => {
    setHighlighted(null);
    if (text.length > HIGHLIGHT_MAX_CHARS) return;
    let cancelled = false;
    const extension = fileExtension(name);
    import("@/lib/syntax-highlighter")
      .then(({ highlightCode }) =>
        highlightCode(text, extension || name.toLowerCase(), window.location.href),
      )
      .then((result) => {
        if (!cancelled) setHighlighted(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [text, name]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !line) return;
    element.scrollTop = Math.max(0, (line - 1) * LINE_HEIGHT_PX - element.clientHeight / 3);
  }, [line, text]);

  return (
    <div
      ref={scrollRef}
      data-responsive-allow="horizontal-scroll"
      className="min-h-0 flex-1 overflow-auto select-text"
    >
      <div
        className="relative flex min-w-max py-2 font-mono text-xs"
        style={{ lineHeight: `${LINE_HEIGHT_PX}px` }}
      >
        {line && line <= lineCount && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bg-amber-400/15"
            style={{ top: 8 + (line - 1) * LINE_HEIGHT_PX, height: LINE_HEIGHT_PX }}
          />
        )}
        <pre
          aria-hidden
          className="sticky left-0 z-[1] m-0 shrink-0 bg-sidebar pr-3 pl-2 text-right text-muted-foreground tabular-nums select-none"
        >
          {Array.from({ length: lineCount }, (_, index) => String(index + 1)).join("\n")}
        </pre>
        <pre className="relative m-0 pr-4 whitespace-pre">
          <code>{highlighted ?? text}</code>
        </pre>
      </div>
    </div>
  );
}

function CsvPreview({ text }: { text: string }) {
  const { t } = useTranslation();
  const { rows, truncated } = useMemo(() => csvPreview(text), [text]);
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3" data-responsive-allow="horizontal-scroll">
      <table className="w-full border-collapse text-left text-sm select-text">
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b border-border">
              {row.map((cell, column) =>
                index === 0 ? (
                  <th
                    key={column}
                    scope="col"
                    className="max-w-80 border border-border bg-muted px-2 py-1.5 font-medium break-words"
                  >
                    {cell}
                  </th>
                ) : (
                  <td
                    key={column}
                    className="max-w-80 border border-border px-2 py-1.5 break-words"
                  >
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <p className="mt-3 text-xs text-muted-foreground">
          {t("filesPanel.csvLimit", { count: rows.length })}
        </p>
      )}
    </div>
  );
}

function ViewSourceSwitch({
  source,
  onChange,
}: {
  source: boolean;
  onChange: (source: boolean) => void;
}) {
  const { t } = useTranslation();
  const option = (value: boolean, label: string) => (
    <button
      type="button"
      aria-pressed={source === value}
      className={cn(
        "rounded-[5px] px-2.5 py-0.5 text-xs text-muted-foreground",
        source === value && "bg-background text-foreground shadow-sm",
      )}
      onClick={() => onChange(value)}
    >
      {label}
    </button>
  );
  return (
    <div className="px-3 pt-2 pb-1">
      <div className="inline-flex rounded-md border border-border bg-muted/60 p-0.5">
        {option(false, t("filesPanel.view"))}
        {option(true, t("filesPanel.source"))}
      </div>
    </div>
  );
}

function HtmlPreview({
  client,
  file,
  content,
}: {
  client: HostFileClient;
  file: HostFileInfo;
  content: string;
}) {
  // SVG files are documents of their own; only HTML pulls in sibling files.
  const inline = fileExtension(file.name) !== "svg";
  const embedded = useHostRequest(
    `${file.path}\n${file.modifiedAt}\n${content.length}`,
    inline
      ? (signal) =>
          inlineLocalHtmlResources(
            content,
            file.path,
            (path, resourceSignal) => client.readBytes(path, resourceSignal),
            signal,
          )
      : null,
    client,
  );
  if (inline && embedded.status === "loading")
    return (
      <PanelMessage>
        <Spinner className="size-4" />
      </PanelMessage>
    );
  // If embedding fails, still show the document without its local files.
  const html = inline && embedded.status === "ready" ? embedded.data : content;
  return (
    <iframe
      title={file.name}
      // No scripts, forms, popups, or same-origin access; the document's own
      // policy also blocks every network request, so local images and fonts
      // arrive embedded as data: URLs.
      sandbox=""
      srcDoc={isolateHtmlDocument(html)}
      className="m-3 min-h-0 flex-1 rounded-md border border-border bg-white"
    />
  );
}

function TextBasedPreview({
  client,
  file,
  kind,
  line,
}: {
  client: HostFileClient;
  file: HostFileInfo;
  kind: "text" | "html" | "markdown" | "csv";
  line: number | null;
}) {
  const { t } = useTranslation();
  const { attachmentBaseUrl } = useWorkspaceState();
  const [source, setSource] = useState(kind === "text" || line !== null);
  useEffect(() => {
    if (line !== null) setSource(true);
  }, [line]);
  const text = useHostRequest(
    `${file.path}\n${file.modifiedAt}`,
    (signal) => client.readText(file, signal),
    client,
  );
  const markdownImages = useMemo(
    () => ({ baseUrl: attachmentBaseUrl, baseDirectory: hostParent(file.path) }),
    [attachmentBaseUrl, file.path],
  );

  if (text.status === "error")
    return (
      <PanelMessage>
        {t(errorMessageKey(text.error.kind))}
        <Button variant="outline" size="sm" onClick={text.retry}>
          {t("filesPanel.retry")}
        </Button>
      </PanelMessage>
    );
  if (text.status === "loading" && text.data === null)
    return (
      <PanelMessage>
        <Spinner className="size-4" />
      </PanelMessage>
    );
  const raw = text.data ?? "";
  const lines = raw.split("\n", 10_001);
  const lineTruncated = lines.length > 10_000;
  const content = lineTruncated ? lines.slice(0, 10_000).join("\n") : raw;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {lineTruncated && (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {t("filesPanel.lineLimit", { count: 10_000 })}
        </p>
      )}
      {kind !== "text" && <ViewSourceSwitch source={source} onChange={setSource} />}
      {source || kind === "text" ? (
        <CodeView text={content} name={file.name} line={line} />
      ) : kind === "csv" ? (
        <CsvPreview text={content} />
      ) : kind === "html" ? (
        <HtmlPreview client={client} file={file} content={content} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <MarkdownImageContext.Provider value={markdownImages}>
            <MarkdownRenderer content={content} />
          </MarkdownImageContext.Provider>
        </div>
      )}
    </div>
  );
}

function NoPreview({
  file,
  onDownload,
  message,
}: {
  file: HostFileInfo;
  onDownload: () => void;
  message: string;
}) {
  const { t, i18n } = useTranslation();
  return (
    <PanelMessage>
      <FileIcon name={file.name} className="size-10 stroke-[1.25]" />
      <div>
        <div className="font-medium break-all text-foreground">{file.name}</div>
        <div className="mt-0.5 text-xs">
          {formatFileSize(file.size, i18n.language)} ·{" "}
          {formatFileDate(file.modifiedAt, i18n.language)}
        </div>
      </div>
      <p className="max-w-64">{message}</p>
      <Button size="sm" onClick={onDownload}>
        <Download />
        {t("filesPanel.download")}
      </Button>
    </PanelMessage>
  );
}

/** Preview body for one file; the caller renders the header and footer. */
export function FilePreview({
  client,
  file,
  line,
  onDownload,
}: {
  client: HostFileClient;
  file: HostFileInfo;
  line: number | null;
  onDownload: () => void;
}) {
  const { t } = useTranslation();
  const { attachmentBaseUrl } = useWorkspaceState();
  const kind = previewKindFor(file.name, file.textEncoding);

  if (kind === "image") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/30 p-4">
        <HostImage
          src={resolveAttachmentImageSrc(file.path, attachmentBaseUrl)}
          alt={file.name}
          className="max-h-full max-w-full object-contain"
          fallbackClassName="h-8 min-w-40"
        />
      </div>
    );
  }
  if (kind === "pdf") {
    return (
      <Suspense
        fallback={
          <PanelMessage>
            <Spinner className="size-4" />
          </PanelMessage>
        }
      >
        <PdfPreview
          client={client}
          file={file}
          fallback={(message) => (
            <NoPreview file={file} onDownload={onDownload} message={message} />
          )}
        />
      </Suspense>
    );
  }
  if (kind === "none") {
    return <NoPreview file={file} onDownload={onDownload} message={t("filesPanel.noPreview")} />;
  }
  return <TextBasedPreview client={client} file={file} kind={kind} line={line} />;
}

/** Footer text: size and date, plus a note when only the start of the text is shown. */
export function previewStatus(
  file: HostFileInfo,
  locale: string,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  const kind = previewKindFor(file.name, file.textEncoding);
  const parts = [formatFileSize(file.size, locale), formatFileDate(file.modifiedAt, locale)];
  const truncated =
    (kind === "text" || kind === "html" || kind === "markdown" || kind === "csv") &&
    file.size > TEXT_PREVIEW_MAX_BYTES;
  return {
    summary: parts.join(" · "),
    note: truncated
      ? t("filesPanel.truncated", { size: formatFileSize(TEXT_PREVIEW_MAX_BYTES, locale) })
      : null,
  };
}
