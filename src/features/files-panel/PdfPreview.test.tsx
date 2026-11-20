// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { createHostFileClient } from "./host-file-client";
import PdfPreview from "./PdfPreview";

const fixture = vi.hoisted(() => ({ getDocument: vi.fn() }));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: fixture.getDocument,
  TextLayer: class {
    async render() {
      throw new Error("Text stream unavailable");
    }
    cancel() {}
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { page?: number }) => (values?.page ? `${key}:${values.page}` : key),
    i18n: { language: "en" },
  }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("reports page and text failures without hiding readable pages", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        this.callback([{ contentRect: { width: 360 } } as ResizeObserverEntry], this);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() {
        this.callback([{ isIntersecting: true }]);
      }
      disconnect() {}
    },
  );
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 300 * scale,
      height: 400 * scale,
      userUnit: 1,
    }),
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
    streamTextContent: vi.fn(),
  };
  fixture.getDocument.mockReturnValue({
    promise: Promise.resolve({
      numPages: 2,
      async getPage(pageNumber: number) {
        if (pageNumber === 1) throw new Error("Page unreadable");
        return page;
      },
    }),
    destroy: vi.fn(),
  });

  const preview = render(
    <PdfPreview
      client={createHostFileClient("https://host.example", null)}
      file={{
        path: "/work/document.pdf",
        name: "document.pdf",
        size: 600,
        modifiedAt: 1,
        textEncoding: null,
      }}
      fallback={(message) => <p>{message}</p>}
    />,
  );

  expect(await screen.findByText("filesPanel.pdfPageFailed:1")).toBeTruthy();
  expect(await screen.findByText("filesPanel.pdfTextUnavailable:2")).toBeTruthy();
  expect(preview.container.querySelector("canvas")?.width).toBeGreaterThan(0);
});
