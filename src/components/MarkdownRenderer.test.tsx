// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

const browser = vi.hoisted(() => ({ copy: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/browser", () => ({
  copyTextToClipboard: browser.copy,
  openExternalLink: browser.open,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      options?.name ? `${key}:${options.name}` : key,
  }),
}));

import { MarkdownImageContext, MarkdownRenderer } from "./MarkdownRenderer";

function renderWithImages(content: string, onOpen = vi.fn()) {
  render(
    <MarkdownImageContext.Provider
      value={{ baseUrl: "http://127.0.0.1:36627", baseDirectory: "/home/me/project", onOpen }}
    >
      <MarkdownRenderer content={content} />
    </MarkdownImageContext.Provider>,
  );
  return onOpen;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MarkdownRenderer", () => {
  test("renders GFM safely and routes external links through the Shell", async () => {
    render(
      <MarkdownRenderer
        content={
          '| A | B |\n|---|---|\n| 1 | 2 |\n\n[Docs](https://example.com)\n\n<script>alert("x")</script>'
        }
      />,
    );
    expect(screen.getByRole("table")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    await userEvent.click(screen.getByRole("link", { name: "Docs" }));
    expect(browser.open).toHaveBeenCalledWith("https://example.com");
  });

  test("copies the exact fenced code and announces completion", async () => {
    browser.copy.mockResolvedValue(undefined);
    render(<MarkdownRenderer content={"```ts\nconst answer: number = 42;\n```"} />);
    const copy = screen.getByRole("button", { name: "markdown.copyCodeLabel" });
    await userEvent.click(copy);
    expect(browser.copy).toHaveBeenCalledWith("const answer: number = 42;");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "markdown.codeCopied" })).toBeTruthy(),
    );
    expect(screen.getByRole("status").textContent).toBe("markdown.codeCopied");
  });

  test("does not navigate to active-content URLs or automatically fetch markdown images", async () => {
    render(
      <MarkdownRenderer
        content={
          "[unsafe](javascript:alert(document.domain)) [data](data:text/html,secret) ![tracking pixel](https://tracker.example/collect?secret=1)"
        }
      />,
    );

    expect(screen.queryByRole("link", { name: "unsafe" })).toBeNull();
    expect(screen.queryByRole("link", { name: "data" })).toBeNull();
    expect(screen.queryByRole("img", { name: "tracking pixel" })).toBeNull();
    expect(screen.getByText("tracking pixel")).toBeTruthy();
    expect(browser.open).not.toHaveBeenCalled();
  });

  test("renders Project images through the Host file route and opens the lightbox", async () => {
    const onOpen = renderWithImages("![Maus auf dem Mars](bilder/maus%20mars.png)");
    const image = screen.getByRole("img", { name: "Maus auf dem Mars" }) as HTMLImageElement;
    const url = new URL(image.src);
    expect(url.origin + url.pathname).toBe("http://127.0.0.1:36627/api/fs/file");
    expect(url.searchParams.get("path")).toBe("/home/me/project/bilder/maus mars.png");
    expect(url.searchParams.get("directory")).toBe("/home/me/project");

    await userEvent.click(
      screen.getByRole("button", { name: "attachments.openImage:Maus auf dem Mars" }),
    );
    expect(onOpen).toHaveBeenCalledWith({
      path: "bilder/maus mars.png",
      filename: "maus mars.png",
    });
  });

  test("keeps Windows paths that the default url sanitizer would drop", () => {
    renderWithImages("![shot](<C:\\Users\\me\\shot.png>)");
    const image = screen.getByRole("img", { name: "shot" }) as HTMLImageElement;
    expect(new URL(image.src).searchParams.get("path")).toBe("C:\\Users\\me\\shot.png");
  });

  test("still blocks remote images when Host images are enabled", () => {
    renderWithImages("![tracking pixel](https://tracker.example/collect.png)");
    expect(screen.queryByRole("img", { name: "tracking pixel" })).toBeNull();
    expect(screen.getByText("tracking pixel")).toBeTruthy();
  });

  test("shows a placeholder when the Host cannot serve the image", async () => {
    renderWithImages("![missing](gone.png)");
    const image = screen.getByRole("img", { name: "missing" });
    image.dispatchEvent(new Event("error"));
    await waitFor(() => expect(screen.getByText("attachments.imageUnavailable")).toBeTruthy());
  });

  test("renders Host paths as alt text without an image context", () => {
    render(<MarkdownRenderer content="![local](shot.png)" />);
    expect(screen.queryByRole("img", { name: "local" })).toBeNull();
    expect(screen.getByText("local")).toBeTruthy();
  });
});
