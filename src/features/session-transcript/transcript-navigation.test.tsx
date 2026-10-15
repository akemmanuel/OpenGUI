// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

import { TranscriptViewport } from "./transcript-viewport";

function setGeometry(
  element: HTMLElement,
  geometry: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => geometry.scrollHeight },
    clientHeight: { configurable: true, get: () => geometry.clientHeight },
    scrollTop: {
      configurable: true,
      get: () => geometry.scrollTop,
      set: (value) => {
        geometry.scrollTop = value;
      },
    },
  });
}

function renderViewport(contentKey: string) {
  return (
    <TranscriptViewport
      sessionId="s1"
      contentKey={contentKey}
      pinWhenNearBottom={false}
      isLoadingOlder={false}
      onLoadOlder={async () => true}
      showLoadOlderRow={false}
    >
      <div>message</div>
    </TranscriptViewport>
  );
}

describe("TranscriptNavigation", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  test("offers a jump to the end once the user scrolls away and re-pins on click", () => {
    render(renderViewport("1"));
    const viewport = screen.getByText("message").parentElement!.parentElement!;
    const button = screen.getByText("messageList.scrollToEnd").closest("button")!;
    expect(button.getAttribute("aria-hidden")).toBe("true");

    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 200 };
    setGeometry(viewport, geometry);
    fireEvent.scroll(viewport);
    expect(button.getAttribute("aria-hidden")).toBe("false");

    fireEvent.click(button);
    expect(geometry.scrollTop).toBe(1600);
    expect(button.getAttribute("aria-hidden")).toBe("true");
  });

  test("flags new output that arrives while reading further up", () => {
    const view = render(renderViewport("1"));
    const viewport = screen.getByText("message").parentElement!.parentElement!;
    setGeometry(viewport, { scrollHeight: 2000, clientHeight: 400, scrollTop: 200 });
    fireEvent.scroll(viewport);
    expect(screen.queryByText("messageList.newMessages")).toBeNull();

    view.rerender(renderViewport("2"));
    expect(screen.getByText("messageList.newMessages")).toBeTruthy();
  });

  test("Alt+End jumps to the end", () => {
    render(renderViewport("1"));
    const viewport = screen.getByText("message").parentElement!.parentElement!;
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 200 };
    setGeometry(viewport, geometry);
    viewport.getClientRects = () => [{}] as unknown as DOMRectList;
    fireEvent.keyDown(window, { key: "End", altKey: true });
    expect(geometry.scrollTop).toBe(1600);
  });
});
