import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlobalWorkerOptions, getDocument, TextLayer, type PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Spinner } from "@/components/ui/spinner";
import type { HostFileClient, HostFileInfo } from "./host-file-client";
import { HostFileError } from "./host-file-client";
import { PanelMessage, errorMessageKey } from "./PanelMessage";
import "./pdf-text-layer.css";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const PAGE_GAP_PX = 12;
const DEFAULT_ASPECT = 1.414;
const MAX_RENDER_WIDTH = 1800;
const ZOOM_STEP = 25;

/** One page, drawn only once it scrolls near the viewport. */
function PdfPage({
  doc,
  pageNumber,
  width,
  aspect,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  width: number;
  aspect: number;
}) {
  const { t } = useTranslation();
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [pageAspect, setPageAspect] = useState(aspect);
  const [problem, setProblem] = useState<"page" | "text" | null>(null);

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(holder);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const textContainer = textLayerRef.current;
    if (!visible || !canvas || !textContainer || width <= 0) return;
    let cancelled = false;
    let renderTask: { cancel(): void; promise: Promise<void> } | null = null;
    let textLayer: TextLayer | null = null;
    setProblem(null);
    const reportPageProblem = () => {
      if (!cancelled) setProblem("page");
    };
    const reportTextProblem = () => {
      if (!cancelled) setProblem((current) => current ?? "text");
    };
    void doc
      .getPage(pageNumber)
      .then((page) => {
        if (cancelled) return;
        const natural = page.getViewport({ scale: 1 });
        setPageAspect(natural.height / natural.width);
        const cssScale = width / natural.width;
        const viewport = page.getViewport({ scale: cssScale * (window.devicePixelRatio || 1) });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        renderTask = page.render({ canvas, viewport });
        void renderTask.promise.catch(reportPageProblem);

        try {
          const textViewport = page.getViewport({ scale: cssScale });
          textContainer.style.setProperty(
            "--total-scale-factor",
            String(cssScale * textViewport.userUnit),
          );
          textLayer = new TextLayer({
            textContentSource: page.streamTextContent(),
            container: textContainer,
            viewport: textViewport,
          });
          void textLayer.render().catch(reportTextProblem);
        } catch {
          reportTextProblem();
        }
      })
      .catch(reportPageProblem);
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      textContainer.replaceChildren();
    };
  }, [doc, pageNumber, visible, width]);

  return (
    <div className="min-w-0" style={{ width }}>
      <div
        ref={holderRef}
        className="relative bg-white shadow-sm ring-1 ring-black/10"
        style={{ height: Math.round(width * pageAspect) }}
      >
        {visible && (
          <>
            <canvas ref={canvasRef} className="block size-full" aria-hidden="true" />
            <div ref={textLayerRef} className="pdf-text-layer" aria-hidden={problem === "page"} />
          </>
        )}
        {problem === "page" && (
          <p role="status" className="absolute inset-0 bg-card p-4 text-sm text-muted-foreground">
            {t("filesPanel.pdfPageFailed", { page: pageNumber })}
          </p>
        )}
      </div>
      {problem === "text" && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {t("filesPanel.pdfTextUnavailable", { page: pageNumber })}
        </p>
      )}
    </div>
  );
}

export default function PdfPreview({
  client,
  file,
  fallback,
}: {
  client: HostFileClient;
  file: HostFileInfo;
  fallback: (message: string) => ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; doc: PDFDocumentProxy; aspect: number }
    | { status: "error"; error: HostFileError | null }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    const task = getDocument({
      ...client.pdfSource(file.path),
      disableAutoFetch: true,
      disableStream: true,
    });
    setState({ status: "loading" });
    task.promise
      .then(async (doc) => {
        let aspect = DEFAULT_ASPECT;
        try {
          const first = (await doc.getPage(1)).getViewport({ scale: 1 });
          aspect = first.height / first.width || DEFAULT_ASPECT;
        } catch {
          // Size the placeholders normally and let each page report its own failure.
        }
        if (!cancelled) setState({ status: "ready", doc, aspect });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ status: "error", error: error instanceof HostFileError ? error : null });
      });
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [client, file.path, file.modifiedAt]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      // Re-render pages only for real width changes, not every pixel of a drag.
      const next = Math.floor((entry?.contentRect.width ?? 0) / 8) * 8;
      setWidth((previous) => (previous === next ? previous : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [state.status]);

  if (state.status === "error") {
    return state.error && state.error.kind !== "tooLarge" ? (
      <PanelMessage>{t(errorMessageKey(state.error.kind))}</PanelMessage>
    ) : (
      fallback(t(state.error ? "filesPanel.errors.tooLarge" : "filesPanel.pdfUnreadable"))
    );
  }
  if (state.status === "loading") {
    return (
      <PanelMessage>
        <Spinner className="size-4" />
      </PanelMessage>
    );
  }

  const pageWidth = Math.min(MAX_RENDER_WIDTH, Math.round((width * zoom) / 100));
  const isWiderThanPanel = pageWidth > width;
  const zoomLabel = new Intl.NumberFormat(i18n.language, { style: "percent" }).format(zoom / 100);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b bg-card/65 px-3 py-1.5">
        <span className="text-xs text-muted-foreground">
          {t("filesPanel.pdfPages", { count: state.doc.numPages })}
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="max-md:size-11"
            aria-label={t("filesPanel.zoomOut")}
            disabled={zoom <= 75}
            onClick={() => setZoom(zoom - ZOOM_STEP)}
          >
            <Minus />
          </Button>
          <span className="min-w-10 text-center text-xs tabular-nums" aria-live="polite">
            {zoom === 100 ? null : zoomLabel}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="max-md:size-11"
            aria-label={t("filesPanel.zoomIn")}
            disabled={zoom >= 200 || pageWidth >= MAX_RENDER_WIDTH}
            onClick={() => setZoom(zoom + ZOOM_STEP)}
          >
            <Plus />
          </Button>
          <Button
            type="button"
            variant={zoom === 100 ? "default" : "outline"}
            size="sm"
            className="max-md:min-h-11"
            aria-pressed={zoom === 100}
            onClick={() => setZoom(100)}
          >
            {t("filesPanel.fitWidth")}
          </Button>
        </div>
      </div>
      {isWiderThanPanel && (
        <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">
          {t("filesPanel.pdfOverflow")}
        </p>
      )}
      <div
        role="region"
        aria-label={t("filesPanel.pdfPreview")}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto bg-muted/40 px-4 py-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <div
          ref={containerRef}
          className="mx-auto grid w-full max-w-[1000px] justify-items-center"
          style={{ gap: PAGE_GAP_PX }}
        >
          {pageWidth > 0 &&
            Array.from({ length: state.doc.numPages }, (_, index) => (
              <PdfPage
                key={index}
                doc={state.doc}
                pageNumber={index + 1}
                width={pageWidth}
                aspect={state.aspect}
              />
            ))}
        </div>
      </div>
    </>
  );
}
