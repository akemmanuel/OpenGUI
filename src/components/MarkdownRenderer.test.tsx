// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

const browser = vi.hoisted(() => ({ copy: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/browser", () => ({
  copyTextToClipboard: browser.copy,
  openExternalLink: browser.open,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { MarkdownRenderer } from "./MarkdownRenderer";

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
});
