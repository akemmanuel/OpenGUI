import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Spinner } from "@/components/ui/spinner";
import type { HostFileClient, HostFileInfo } from "./host-file-client";
import { HostFileError } from "./host-file-client";
import { PanelMessage, errorMessageKey } from "./PanelMessage";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const PAGE_GAP_PX = 12;
const DEFAULT_ASPECT = 1.414;

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
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [pageAspect, setPageAspect] = useState(aspect);

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
    if (!visible || !canvas || width <= 0) return;
    let cancelled = false;
    let renderTask: { cancel(): void; promise: Promise<void> } | null = null;
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
        renderTask.promise.catch(() => {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [doc, pageNumber, visible, width]);

  return (
    <div
      ref={holderRef}
      className="bg-white shadow-sm ring-1 ring-black/10"
      style={{ width, height: Math.round(width * pageAspect) }}
    >
      {visible && <canvas ref={canvasRef} className="block size-full" />}
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
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
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
        const first = (await doc.getPage(1)).getViewport({ scale: 1 });
        if (!cancelled)
          setState({ status: "ready", doc, aspect: first.height / first.width || DEFAULT_ASPECT });
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

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-muted/40 px-4 py-4">
      <div
        ref={containerRef}
        className="mx-auto flex w-full max-w-[1000px] flex-col items-center"
        style={{ gap: PAGE_GAP_PX }}
      >
        {width > 0 &&
          Array.from({ length: state.doc.numPages }, (_, index) => (
            <PdfPage
              key={index}
              doc={state.doc}
              pageNumber={index + 1}
              width={width}
              aspect={state.aspect}
            />
          ))}
      </div>
    </div>
  );
}
